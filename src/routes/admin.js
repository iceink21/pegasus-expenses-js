// Team-lead admin view: all expenses, flags, audit log, CSV/xlsx export, and
// the review of evidence that did not verify automatically.

import express from "express";

import { AuditAction, writeAudit } from "../audit.js";
import { adminPrincipal, requireAdmin } from "../auth.js";
import { toCsv } from "../csv.js";
import { statement } from "../db/connection.js";
import {
  SELECT_AUDIT_RECENT,
  SELECT_EXPENSES_ALL,
  SELECT_EXPENSES_EXPORT,
  SELECT_EXPENSES_FLAGGED,
} from "../db/sql.js";
import { decisionView, loadExpense, ReviewDecision, reviewExpense } from "../decision.js";
import { HttpError } from "../http-error.js";
import { Action, requireAccess, requirePermission } from "../permissions.js";
import { loadTotals } from "../totals.js";
import { buildTotalsWorkbook, XLSX_MIME } from "../xlsx.js";
import { INTEGER_ID, NOTE_MAX_CHARS, parseAmount } from "./expenses.js";
import { enforce, sendPage } from "./http.js";

const LIST_LIMIT = 200;
const AUDIT_LIMIT = 100;
const REVIEW_BODY_LIMIT = "4kb";

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
