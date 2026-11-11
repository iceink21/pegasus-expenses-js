// Team-lead admin view: all expenses, flags, audit log, CSV/xlsx export, and
// the review of evidence that did not verify automatically.

import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import archiver from "archiver";
import express from "express";

import { AuditAction, writeAudit } from "../audit.js";
import { adminPrincipal, requireAdmin } from "../auth.js";
import { toCsv } from "../csv.js";
import { statement } from "../db/connection.js";
import {
  SELECT_AUDIT_RECENT,
  SELECT_EXPENSES_ALL,
  SELECT_EXPENSES_FILTERED,
  SELECT_EXPENSES_EXPORT,
  SELECT_EXPENSES_FLAGGED,
} from "../db/sql.js";
import { decisionView, loadExpense, ReviewDecision, reviewExpense } from "../decision.js";
import { HttpError } from "../http-error.js";
import { Action, requireAccess, requirePermission } from "../permissions.js";
import { loadTotals } from "../totals.js";
import { buildTotalsWorkbook, XLSX_MIME } from "../xlsx.js";
import { INTEGER_ID, NOTE_MAX_CHARS, parseAmount } from "./expenses.js";
import { memberFolderName } from "../storage/base.js";
import { createLogger } from "../log.js";
import { enforce, queryString, sendPage } from "./http.js";

const logger = createLogger("pegasus.admin");
const LIST_LIMIT = 200;
const AUDIT_LIMIT = 100;
const REVIEW_BODY_LIMIT = "4kb";
const SLIP_ID = /^[1-9]\d{0,11}$/;
const DRIVE_HOSTS = new Set(["drive.google.com", "docs.google.com"]);
const VERDICT_FOLDERS = new Set(["verified", "needs-review", "rejected", "legacy"]);
// Inline allow-list: images only (nothing uploads a PDF, and an inline PDF
// would run on the app origin). A file is shown inline only when its leading
// bytes ALSO match its extension; anything else is an attachment.
const SLIP_TYPES = Object.freeze({
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
});
const MAGIC_CHECKS = Object.freeze({
  "image/jpeg": (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b.length >= 4 && b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  "image/webp": (b) => b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP",
  "image/heic": (b) => b.length >= 8 && b.toString("latin1", 4, 8) === "ftyp",
});

/** True when the file's first bytes match what its extension claims. */
async function headerMatches(file, type) {
  const handle = await fs.promises.open(file, "r");
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, 16, 0);
    return MAGIC_CHECKS[type](buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/** Validate the review body. Returns { decision, approvedAmount, note }. */
export function parseReviewBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_body");
  const decision = body.decision;
  if (decision !== ReviewDecision.APPROVE && decision !== ReviewDecision.REJECT) {
    throw new HttpError(400, "invalid_decision");
  }

  let note = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== "string") throw new HttpError(400, "invalid_note");
    const trimmed = body.note.trim();
    if ([...trimmed].length > NOTE_MAX_CHARS) throw new HttpError(400, "note_too_long");
    note = trimmed || null;
  }

  let approvedAmount = null;
  if (decision === ReviewDecision.APPROVE) {
    const raw = body.approved_amount;
    if (raw === undefined || raw === null || raw === "") throw new HttpError(400, "amount_required");
    // Only a JSON number or string; String([5]) would otherwise sneak through.
    if (typeof raw !== "number" && typeof raw !== "string") throw new HttpError(400, "amount_not_a_number");
    approvedAmount = parseAmount(String(raw));
  }
  return { decision, approvedAmount, note };
}

function isDriveUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "https:" && DRIVE_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function createAdminRouter(ctx) {
  const { db, settings, providers } = ctx;
  const router = express.Router();

  const auditSuccess = (principal, action, subjectId, detail) =>
    writeAudit(db, {
      actorKind: principal.kind,
      actorName: principal.name,
      action,
      subjectType: "admin",
      subjectId,
      outcome: "success",
      detail,
      clientIp: principal.clientIp,
    });

  // Subject "slip" (view) / "slips" (zip); the denial itself is audited by the gate.
  const auditSlip = (principal, action, subjectId, outcome, detail) =>
    writeAudit(db, {
      actorKind: principal.kind,
      actorName: principal.name,
      action,
      subjectType: "expense",
      subjectId,
      outcome,
      detail,
      clientIp: principal.clientIp,
    });

  router.get("/admin", requireAdmin(ctx, "page"), (req, res) => sendPage(res, "admin.html"));
  router.get("/admin/audit", requireAdmin(ctx, "page"), (req, res) => sendPage(res, "audit.html"));

  router.get("/api/admin/dashboard", requireAdmin(ctx, "api"), (req, res) => {
    const principal = adminPrincipal(req, settings);
    enforce(() => requirePermission(db, principal, Action.EXPENSE_READ_ALL));
    const rows = statement(db, SELECT_EXPENSES_ALL).all(LIST_LIMIT);
    const flagged = statement(db, SELECT_EXPENSES_FLAGGED).all(LIST_LIMIT);
    const { members, grand } = loadTotals(db);
    auditSuccess(principal, AuditAction.ADMIN_VIEW, "dashboard", {
      rows: rows.length,
      flagged: flagged.length,
    });
    res.json({
      rows,
      flagged_count: flagged.length,
      totals: members,
      grand,
      // Kept for older consumers: the claimed total excluding rejected rows.
      grand_total: grand.claimed_total,
      providers: providers.describe(),
    });
  });

  // Read-only claims list for the admin table. ?verdict= is the evidence
  // folder (Verified / Needs-Review / Rejected), ?member= a name substring.
  router.get("/api/admin/expenses", requireAdmin(ctx, "api"), (req, res) => {
    const principal = adminPrincipal(req, settings);
    enforce(() => requirePermission(db, principal, Action.EXPENSE_READ_ALL));
    const verdict = queryString(req, "verdict");
    if (verdict && !VERDICT_FOLDERS.has(verdict)) throw new HttpError(400, "invalid_verdict");
    const member = queryString(req, "member").trim().slice(0, 100);
    const like = member ? "%" + member.replace(/[\\%_]/g, "\\$&") + "%" : null;
    const rows = statement(db, SELECT_EXPENSES_FILTERED).all(
      verdict || null, verdict || null, like, like, LIST_LIMIT,
    );
    auditSuccess(principal, AuditAction.ADMIN_VIEW, "expenses", {
      rows: rows.length,
      verdict: verdict || null,
      member: member || null,
    });
    res.json({ rows });
  });

  router.get("/api/admin/audit", requireAdmin(ctx, "api"), (req, res) => {
    const principal = adminPrincipal(req, settings);
    enforce(() => requirePermission(db, principal, Action.AUDIT_READ));
    const rows = statement(db, SELECT_AUDIT_RECENT).all(AUDIT_LIMIT);
    auditSuccess(principal, AuditAction.ADMIN_VIEW_AUDIT, "audit", { rows: rows.length });
    res.json({ rows });
  });

  // A download link the browser navigates to, so it gates like a page.
  router.get("/admin/export.csv", requireAdmin(ctx, "page"), (req, res) => {
    const principal = adminPrincipal(req, settings);
    enforce(() => requirePermission(db, principal, Action.EXPENSE_EXPORT));
    const rows = statement(db, SELECT_EXPENSES_EXPORT).all();
    auditSuccess(principal, AuditAction.ADMIN_EXPORT_CSV, "export", { rows: rows.length });
    res
      .type("text/csv; charset=utf-8")
      .set("Content-Disposition", "attachment; filename=\"pegasus_expenses.csv\"")
      .send(toCsv(rows));
  });

  // Same gate as the CSV: a browser download link.
  router.get("/admin/totals.xlsx", requireAdmin(ctx, "page"), async (req, res) => {
    const principal = adminPrincipal(req, settings);
    enforce(() => requirePermission(db, principal, Action.EXPENSE_EXPORT));
    const totals = loadTotals(db);
    const expenses = statement(db, SELECT_EXPENSES_EXPORT).all();
    const workbook = await buildTotalsWorkbook({ totals, expenses });
    auditSuccess(principal, AuditAction.ADMIN_EXPORT_XLSX, "export", {
      members: totals.members.length,
      rows: expenses.length,
    });
    res
      .type(XLSX_MIME)
      .set("Content-Disposition", "attachment; filename=\"pegasus_totals.xlsx\"")
      .set("Cache-Control", "no-store")
      .send(workbook);
  });

  // The slip image. The file is found ONLY through the evidence ref stored in
  // the database, checked by the storage backend; the URL supplies just the id.
  router.get("/admin/expenses/:id/slip", requireAdmin(ctx, "page"), async (req, res) => {
    const principal = adminPrincipal(req, settings);
    enforce(() => requirePermission(db, principal, Action.EXPENSE_READ_ALL));
    if (!SLIP_ID.test(req.params.id)) {
      auditSlip(principal, AuditAction.ADMIN_VIEW_SLIP, String(req.params.id).slice(0, 40), "failure", { reason: "invalid_id" });
      throw new HttpError(422, "invalid_id");
    }
    const row = loadExpense(db, Number(req.params.id));
    if (!row) {
      auditSlip(principal, AuditAction.ADMIN_VIEW_SLIP, req.params.id, "failure", { reason: "not_found" });
      throw new HttpError(404, "not_found");
    }
    const storage = providers.storage;
    const isLocal = typeof storage.checkedSource === "function" && row.evidence_backend === storage.name;
    if (!isLocal) {
      // Google Drive: nothing on disk, send the admin to the Drive link.
      if (isDriveUrl(row.evidence_url)) {
        auditSlip(principal, AuditAction.ADMIN_VIEW_SLIP, row.id, "success", { via: "redirect" });
        res.set("Cache-Control", "private, no-store").redirect(302, row.evidence_url);
        return;
      }
      auditSlip(principal, AuditAction.ADMIN_VIEW_SLIP, row.id, "failure", { reason: "no_file" });
      throw new HttpError(404, "slip_not_found");
    }
    let file;
    let size;
    let inline = null;
    try {
      file = await storage.checkedSource(row.evidence_ref);
      size = (await fs.promises.stat(file)).size;
      const claimed = SLIP_TYPES[path.extname(file).toLowerCase()];
      if (claimed && (await headerMatches(file, claimed))) inline = claimed;
    } catch {
      auditSlip(principal, AuditAction.ADMIN_VIEW_SLIP, row.id, "failure", { reason: "file_missing_or_unsafe" });
      throw new HttpError(404, "slip_not_found");
    }
    auditSlip(principal, AuditAction.ADMIN_VIEW_SLIP, row.id, "success", { via: "stream", inline: inline !== null });
    res.set({
      "Content-Type": inline ?? "application/octet-stream",
      "Content-Length": String(size),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
    if (!inline) res.set("Content-Disposition", "attachment; filename=\"slip" + path.extname(file).replace(/[^A-Za-z0-9.]/g, "") + "\"");
    await pipeline(fs.createReadStream(file), res).catch(() => {});
  });

  // Every local slip as <name>_M<id>/<verdict>/<file>, streamed from disk.
  router.get("/admin/slips.zip", requireAdmin(ctx, "page"), async (req, res) => {
    const principal = adminPrincipal(req, settings);
    enforce(() => requirePermission(db, principal, Action.EXPENSE_EXPORT));
    const storage = providers.storage;
    const entries = [];
    const seen = new Set();
    let skipped = 0;
    let warnings = 0;
    let finished = false;
    let gone = false; // the response is already closed
    let started = false; // the "started" row exists, so a closing row is owed
    let closed = false; // the closing row has been written (exactly once)
    let archive = null;
    // The closing row is written from an event handler, where a throw (disk
    // full, locked DB) would be uncaught and kill the process: log, don't rethrow.
    const closeAudit = () => {
      if (!started || closed) return;
      closed = true;
      try {
        auditSlip(principal, AuditAction.ADMIN_EXPORT_SLIPS, "all", finished ? "success" : "aborted", {
          files: entries.length,
          skipped,
          warnings,
        });
      } catch (error) {
        logger.error("could not write the slips.zip closing audit row:", error);
      }
    };
    // Attached BEFORE the awaits below: a client that leaves during the DB/file
    // loop has already fired "close" by the time the loop ends.
    res.on("finish", () => { finished = true; });
    res.on("close", () => {
      gone = true;
      if (archive && !finished) archive.abort();
      closeAudit();
    });
    for (const row of statement(db, SELECT_EXPENSES_EXPORT).all()) {
      let file;
      try {
        if (typeof storage.checkedSource !== "function" || row.evidence_backend !== storage.name) throw new Error("not local");
        file = await storage.checkedSource(row.evidence_ref);
      } catch {
        skipped += 1;
        continue;
      }
      const folder =
        row.member_id === null ? "unlinked" : memberFolderName({ memberId: row.member_id, memberName: row.member_name });
      const name = folder + "/" + (row.evidence_folder ?? "legacy") + "/" + path.basename(file);
      if (seen.has(name)) continue; // legacy rows may share one file
      seen.add(name);
      entries.push({ file, name });
    }
    // Written before streaming, so it says "started"; the close handler below
    // adds the outcome once the transfer is known.
    auditSlip(principal, AuditAction.ADMIN_EXPORT_SLIPS, "all", "started", { files: entries.length, skipped });
    started = true;
    if (gone || res.destroyed) {
      closeAudit(); // the client left during the loop: aborted, nothing to stream
      return;
    }
    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": "attachment; filename=\"pegasus_slips.zip\"",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    // Images are already compressed: store, don't deflate. Files are opened
    // one at a time by archiver, so memory stays flat.
    archive = archiver("zip", { store: true });
    archive.on("warning", () => { warnings += 1; }); // e.g. a file vanished mid-stream
    archive.on("error", () => res.destroy());
    archive.pipe(res);
    for (const entry of entries) archive.file(entry.file, { name: entry.name });
    await archive.finalize().catch(() => {});
  });

  router.post(
    "/api/admin/expenses/:id/review",
    requireAdmin(ctx, "api"),
    express.json({ limit: REVIEW_BODY_LIMIT, strict: true }),
    async (req, res) => {
      if (!INTEGER_ID.test(req.params.id)) throw new HttpError(422, "invalid_id");
      const principal = adminPrincipal(req, settings);
      enforce(() => requirePermission(db, principal, Action.EXPENSE_REVIEW));
      const row = loadExpense(db, Number(req.params.id));
      if (!row) throw new HttpError(404, "not_found");
      enforce(() => requireAccess(db, principal, row, Action.EXPENSE_REVIEW));
      const { decision, approvedAmount, note } = parseReviewBody(req.body);

      const updated = await reviewExpense(db, { principal, providers, row, decision, approvedAmount, note });
      res.json({
        detail_level: "admin",
        expense: updated,
        view: decisionView(updated, settings),
        using_stub_ocr: providers.usingStubOcr,
      });
    },
  );

  return router;
}
