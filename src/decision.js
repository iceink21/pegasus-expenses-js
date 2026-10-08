// THE DECISION POINT.
//
// Everything that turns an upload into a verdict happens in recordSubmission.
// The verdict is computed here, server-side, from the extracted amount — the
// browser never asserts a match, and no request field can influence the
// outcome.
//
// Audit rows are written inside this function, in the same transaction as the
// expense row, before the single commit. There is no wrapper, middleware, or
// response hook involved, so nothing a handler does afterwards (an early
// return, an exception, a 4xx) can produce a decision that went unlogged.
//
// Async work (evidence upload, OCR, slip verification) all finishes BEFORE the
// transaction opens; the BEGIN..COMMIT block itself is synchronous, so another
// request cannot interleave its statements with this one.

import crypto from "node:crypto";

import { AuditAction, utcNowIso, writeAudit } from "./audit.js";
import { inTransaction, statement } from "./db/connection.js";
import { INSERT_EXPENSE, SELECT_EXPENSE_BY_ID, SELECT_FIRST_BY_SHA } from "./db/sql.js";
import { Source } from "./extraction/base.js";
import { pyRound2 } from "../shared/numbers.js";

export const Verdict = Object.freeze({
  MATCH: "MATCH",
  MISMATCH: "MISMATCH",
  UNREADABLE: "UNREADABLE",
});

export const FlagReason = Object.freeze({
  AMOUNT_MISMATCH: "amount_mismatch",
  DUPLICATE_IMAGE: "duplicate_image",
});

const AUDIT_ACTION_BY_VERDICT = Object.freeze({
  [Verdict.MATCH]: AuditAction.EXPENSE_MATCH,
  [Verdict.MISMATCH]: AuditAction.EXPENSE_MISMATCH,
  [Verdict.UNREADABLE]: AuditAction.EXPENSE_UNREADABLE,
});

export function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** Pure verdict function. Returns { verdict, difference, tolerance }. */
export function decideVerdict(claimed, extracted, settings) {
  const tolerance = settings.toleranceFor(claimed);
  if (extracted === null || extracted === undefined) {
    return { verdict: Verdict.UNREADABLE, difference: null, tolerance };
  }
  const difference = pyRound2(Math.abs(claimed - extracted));
  if (difference <= tolerance + 1e-9) return { verdict: Verdict.MATCH, difference, tolerance };
  return { verdict: Verdict.MISMATCH, difference, tolerance };
}

/** Store evidence, extract, decide, persist, audit — one transaction. */
export async function recordSubmission(
  db,
  { principal, settings, providers, memberName, category, note, claimedAmount, imageBytes, filename, contentType },
) {
  const imageHash = sha256Hex(imageBytes);

  // --- duplicate detection (read) ---------------------------------
  const duplicateRow = statement(db, SELECT_FIRST_BY_SHA).get(imageHash) ?? null;
  const duplicateOfId = duplicateRow ? Number(duplicateRow.id) : null;

  // --- evidence ----------------------------------------------------
  let evidence;
  if (duplicateRow) {
    // Same bytes already stored; reuse the original reference rather than
    // uploading a second identical file.
    evidence = {
      backend: String(duplicateRow.evidence_backend),
      ref: String(duplicateRow.evidence_ref),
      url: duplicateRow.evidence_url,
    };
  } else {
    evidence = await providers.storage.store({ data: imageBytes, filename, contentType });
  }

  // --- extraction: QR (bonus) -> OCR (workhorse) -> LLM (fallback) -
  const extraction = await providers.pipeline.run(imageBytes, contentType);

  // --- slip verification seam (no-op in v1) ------------------------
  const verification = await providers.slipVerifier.verify({ imageBytes, claimedAmount });

  // --- verdict: server-side, from config tolerance -----------------
  const { verdict, difference, tolerance } = decideVerdict(claimedAmount, extraction.amount, settings);

  const flagReasons = [];
  if (verdict === Verdict.MISMATCH) flagReasons.push(FlagReason.AMOUNT_MISMATCH);
  if (duplicateOfId !== null) flagReasons.push(FlagReason.DUPLICATE_IMAGE);
  // UNREADABLE is never a flag. A bad photo is not an accusation.
  const flagged = flagReasons.length > 0 ? 1 : 0;
  const flagReason = flagReasons.length > 0 ? flagReasons.join(",") : null;
  const extractionSource = extraction.source || Source.NONE;

  const expenseId = inTransaction(db, () => {
    const inserted = statement(db, INSERT_EXPENSE).run(
      utcNowIso(),
      memberName,
      category,
      note,
      claimedAmount,
      extraction.amount,
      extractionSource,
      extraction.detail,
      verdict,
      flagged,
      flagReason,
      imageHash,
      duplicateOfId,
      evidence.backend,
      evidence.ref,
      evidence.url,
    );
    const id = Number(inserted.lastInsertRowid);

    // --- AUDIT, written here at the decision point -----------------
    writeAudit(db, {
      actorKind: principal.kind,
      actorName: principal.name,
      action: AUDIT_ACTION_BY_VERDICT[verdict],
      subjectType: "expense",
      subjectId: id,
      outcome: verdict,
      detail: {
        member: memberName,
        claimed: claimedAmount,
        extracted: extraction.amount,
        difference,
        tolerance,
        source: extraction.source,
        extractor: extraction.extractor || null,
        extraction_detail: extraction.detail,
        ocr_provider: providers.ocrStage.name,
        using_stub_ocr: providers.usingStubOcr,
        slip_verification: verification.status,
        image_sha256: imageHash,
        notes: extraction.notes,
      },
      clientIp: principal.clientIp,
    });

    if (duplicateOfId !== null) {
      writeAudit(db, {
        actorKind: principal.kind,
        actorName: principal.name,
        action: AuditAction.EXPENSE_DUPLICATE,
        subjectType: "expense",
        subjectId: id,
        outcome: "flagged",
        detail: {
          duplicate_of_id: duplicateOfId,
          image_sha256: imageHash,
          original_member: String(duplicateRow.member_name),
        },
        clientIp: principal.clientIp,
      });
    }
    return id;
  });

  return Object.freeze({
    expense_id: expenseId,
    verdict,
    flagged: Boolean(flagged),
    flag_reason: flagReason,
    claimed_amount: claimedAmount,
    extracted_amount: extraction.amount,
    extraction_source: extractionSource,
    extraction_detail: extraction.detail,
    extractor: extraction.extractor || null,
    difference,
    tolerance,
    duplicate_of_id: duplicateOfId,
    is_duplicate: duplicateOfId !== null,
    evidence_backend: evidence.backend,
    evidence_url: evidence.url,
    image_sha256: imageHash,
  });
}

export function loadExpense(db, expenseId) {
  return statement(db, SELECT_EXPENSE_BY_ID).get(expenseId) ?? null;
}

/**
 * The result-page view of a stored expense: the row plus the difference and
 * tolerance the decision used. The Python result page received these from the
 * in-memory Decision; here the page is a separate GET, so they are recomputed
 * with the same functions (tolerance uses the CURRENT epsilon settings).
 */
export function decisionView(row, settings) {
  const { difference, tolerance } = decideVerdict(row.claimed_amount, row.extracted_amount, settings);
  return { difference, tolerance, is_duplicate: row.duplicate_of_id !== null };
}
