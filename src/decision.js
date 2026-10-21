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
// Async work (OCR, slip verification, evidence upload) all finishes BEFORE the
// transaction opens; the BEGIN..COMMIT block itself is synchronous, so another
// request cannot interleave its statements with this one.
//
// Evidence is stored AFTER the verdict, because the verdict picks the folder
// (routeFolder). The folder is a pure function of server-side facts; nothing
// in the request can steer a file into "verified".
//
// The second decision made here is the admin review (reviewExpense): approve
// with a corrected amount, or reject. It moves the file, then records the
// outcome and its audit row in one transaction.

import crypto from "node:crypto";

import { AuditAction, utcNowIso, writeAudit } from "./audit.js";
import { inTransaction, statement } from "./db/connection.js";
import {
  INSERT_EXPENSE,
  SELECT_EXPENSE_BY_ID,
  SELECT_FIRST_BY_SHA,
  SELECT_OTHER_ROWS_SHARING_EVIDENCE,
  UPDATE_EXPENSE_REVIEW,
} from "./db/sql.js";
import { Source } from "./extraction/base.js";
import { HttpError } from "./http-error.js";
import { createLogger } from "./log.js";
import { EvidenceFolder } from "./storage/base.js";
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

export const ReviewStatus = Object.freeze({
  VERIFIED: "verified",
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
});

export const ReviewDecision = Object.freeze({ APPROVE: "approve", REJECT: "reject" });

const logger = createLogger("pegasus.decision");

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

/**
 * Pure routing rule. Only a clean MATCH (no flag of any kind, duplicates
 * included) goes to "verified"; MISMATCH, UNREADABLE and every duplicate wait
 * in "needs-review". "rejected" is reached only through an admin review.
 */
export function routeFolder(verdict, flagged) {
  return verdict === Verdict.MATCH && !flagged ? EvidenceFolder.VERIFIED : EvidenceFolder.NEEDS_REVIEW;
}

/** review_status a new row starts in, given its routed folder. */
export function initialReviewStatus(folder) {
  return folder === EvidenceFolder.VERIFIED ? ReviewStatus.VERIFIED : ReviewStatus.PENDING;
}

/** Extract, decide, route + store evidence, persist, audit — one transaction. */
export async function recordSubmission(
  db,
  {
    principal,
    settings,
    providers,
    memberId,
    memberName,
    category,
    note,
    claimedAmount,
    imageBytes,
    filename,
    contentType,
  },
) {
  const imageHash = sha256Hex(imageBytes);

  // --- duplicate detection (read) ---------------------------------
  const duplicateRow = statement(db, SELECT_FIRST_BY_SHA).get(imageHash) ?? null;
  const duplicateOfId = duplicateRow ? Number(duplicateRow.id) : null;

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

  // --- evidence: routed by the verdict just computed ----------------
  // A NEW duplicate gets its own copy (in needs-review) rather than pointing
  // at the original's file. Rows stored before 2026-10-20 may still share one
  // file with their original; reviewExpense copies instead of moving for those.
  const evidenceFolder = routeFolder(verdict, flagged);
  const reviewStatus = initialReviewStatus(evidenceFolder);
  const evidence = await providers.storage.store({
    data: imageBytes,
    filename,
    contentType,
    folder: evidenceFolder,
    ownerTag: "M" + memberId,
  });

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
      memberId,
      reviewStatus,
      evidenceFolder,
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
        member_id: memberId,
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
        evidence_folder: evidenceFolder,
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

  // The full decision. Routes must pass it through views.js before it reaches
  // a non-admin session.
  return Object.freeze({
    expense_id: expenseId,
    member_id: memberId,
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
    evidence_folder: evidenceFolder,
    review_status: reviewStatus,
    image_sha256: imageHash,
  });
}

// Reviews in flight, per database handle. Node runs one request at a time
// between awaits, so this stops two admins moving the same file at once in
// this process; the `review_status = 'pending'` re-check inside the
// transaction is the guarantee across processes.
const reviewsInFlight = new WeakMap();

function reviewLock(db, expenseId) {
  let ids = reviewsInFlight.get(db);
  if (!ids) {
    ids = new Set();
    reviewsInFlight.set(db, ids);
  }
  if (ids.has(expenseId)) throw new HttpError(409, "review_in_progress");
  ids.add(expenseId);
  return () => ids.delete(expenseId);
}

const errorText = (error) => String(error?.message ?? error).slice(0, 300);

/** Write an audit row without letting a broken database mask the real error. */
function auditQuietly(db, entry) {
  try {
    writeAudit(db, entry);
  } catch (error) {
    logger.error("audit write failed for " + entry.action + ":", errorText(error));
  }
}

/**
 * THE REVIEW DECISION. `row` is a pending expense the caller has already
 * permission- and scope-checked; `decision`, `approvedAmount` and `note` are
 * validated. Order: put the file in the target folder (async) → one
 * synchronous transaction that re-checks the row is still pending, writes the
 * review and its audit row.
 *
 * The file is MOVED, unless other rows point at the same stored file (legacy
 * duplicates reused their original's ref): then the reviewed row gets its own
 * COPY in the target folder and the shared file is not touched, so rejecting a
 * duplicate can never drag the genuine original into Rejected.
 *
 * Every outcome after the file operation is audited: the decision itself, a
 * lost race (expense.review.conflict) and a failed transaction
 * (expense.review.tx_failed), each with whether the file operation was undone.
 *
 * claimed_amount and verdict are never touched: the member's claim and the
 * machine's judgement stay on record next to the admin's figure.
 */
export async function reviewExpense(db, { principal, providers, row, decision, approvedAmount, note }) {
  const expenseId = Number(row.id);
  if (row.review_status !== ReviewStatus.PENDING) throw new HttpError(409, "not_pending");
  const approve = decision === ReviewDecision.APPROVE;
  const toFolder = approve ? EvidenceFolder.VERIFIED : EvidenceFolder.REJECTED;
  const newStatus = approve ? ReviewStatus.APPROVED : ReviewStatus.REJECTED;
  const approved = approve ? approvedAmount : null;
  const fromFolder = row.evidence_folder ?? null;
  const storage = providers.storage;
  const auditBase = {
    actorKind: principal.kind,
    actorName: principal.name,
    subjectType: "expense",
    subjectId: expenseId,
    clientIp: principal.clientIp,
  };

  const release = reviewLock(db, expenseId);
  try {
    const sharedWith = statement(db, SELECT_OTHER_ROWS_SHARING_EVIDENCE)
      .all(row.evidence_backend, row.evidence_ref, expenseId)
      .map((other) => Number(other.id));
    const copied = sharedWith.length > 0;
    const fileDetail = {
      decision,
      from_folder: fromFolder,
      to_folder: toFolder,
      copied_shared_evidence: copied,
      shared_with_ids: sharedWith,
    };

    // --- put the evidence in the target folder ------------------------
    let evidence;
    try {
      if (row.evidence_backend !== storage.name) {
        throw new Error("evidence is in " + row.evidence_backend + " but the active storage is " + storage.name);
      }
      evidence = copied
        ? await storage.copy(row.evidence_ref, toFolder, { ownerTag: "M" + row.member_id })
        : await storage.move(row.evidence_ref, toFolder);
    } catch (error) {
      // AUDIT at the point of failure; the row stays pending.
      auditQuietly(db, {
        ...auditBase,
        action: AuditAction.EXPENSE_REVIEW_MOVE_FAILED,
        outcome: "error",
        detail: { ...fileDetail, evidence_backend: row.evidence_backend, error: errorText(error) },
      });
      logger.error("review of expense " + expenseId + ": evidence " + (copied ? "copy" : "move") + " failed:", errorText(error));
      throw new HttpError(502, "evidence_move_failed");
    }

    /** Undo the file operation so the stored ref is true again. */
    const undo = async (backTo) => {
      try {
        if (copied) await storage.remove(evidence.ref);
        else await storage.move(evidence.ref, backTo);
        return { undo: copied ? "removed_copy" : "moved_back", undo_ok: true };
      } catch (error) {
        logger.error("review of expense " + expenseId + ": undo failed:", errorText(error));
        return { undo: copied ? "removed_copy" : "moved_back", undo_ok: false, undo_error: errorText(error) };
      }
    };
    // Where the file was before this review (legacy = the storage root).
    const originalFolder = fromFolder ?? EvidenceFolder.LEGACY;

    // --- record the decision + audit, one transaction -----------------
    const reviewedAt = utcNowIso();
    let updated;
    try {
      updated = inTransaction(
        db,
        () => {
          const changes = Number(
            statement(db, UPDATE_EXPENSE_REVIEW).run(
              newStatus,
              approved,
              principal.name,
              reviewedAt,
              note,
              evidence.backend,
              evidence.ref,
              evidence.url,
              toFolder,
              expenseId,
            ).changes,
          );
          if (changes !== 1) return false;
          writeAudit(db, {
            ...auditBase,
            action: approve ? AuditAction.EXPENSE_REVIEW_APPROVED : AuditAction.EXPENSE_REVIEW_REJECTED,
            outcome: newStatus,
            detail: {
              claimed_amount: row.claimed_amount,
              approved_amount: approved,
              verdict: row.verdict,
              from_folder: fromFolder,
              to_folder: toFolder,
              copied_shared_evidence: copied,
              shared_with_ids: sharedWith,
              note,
              member: row.member_name,
              member_id: row.member_id,
            },
          });
          return true;
        },
        { immediate: true },
      );
    } catch (error) {
      // Rolled back: the row still says pending with the OLD ref, so the file
      // must go back too or every later review would fail with a stale ref.
      const undone = await undo(originalFolder);
      auditQuietly(db, {
        ...auditBase,
        action: AuditAction.EXPENSE_REVIEW_TX_FAILED,
        outcome: "error",
        detail: { ...fileDetail, ...undone, error: errorText(error) },
      });
      throw error;
    }

    if (!updated) {
      // Another process reviewed it between our read and our write. Make the
      // file match the committed row again, and say so in the audit log.
      const current = loadExpense(db, expenseId);
      let undone = { undo: "not_needed", undo_ok: true };
      if (copied) {
        undone = await undo(null);
      } else if (current && current.evidence_folder && current.evidence_folder !== toFolder) {
        undone = await undo(current.evidence_folder);
      }
      auditQuietly(db, {
        ...auditBase,
        action: AuditAction.EXPENSE_REVIEW_CONFLICT,
        outcome: "conflict",
        detail: { ...fileDetail, ...undone, committed_status: current?.review_status ?? null },
      });
      throw new HttpError(409, "not_pending");
    }
    return loadExpense(db, expenseId);
  } finally {
    release();
  }
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
