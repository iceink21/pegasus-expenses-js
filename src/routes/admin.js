// Team-lead admin view: all expenses, flags, audit log, CSV export.

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
  SELECT_GRAND_TOTAL,
  SELECT_TOTALS_BY_MEMBER,
} from "../db/sql.js";
import { Action, requirePermission } from "../permissions.js";
import { enforce, sendPage } from "./http.js";

const LIST_LIMIT = 200;
const AUDIT_LIMIT = 100;

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
    const totals = statement(db, SELECT_TOTALS_BY_MEMBER).all();
    const grand = statement(db, SELECT_GRAND_TOTAL).get();
    auditSuccess(principal, AuditAction.ADMIN_VIEW, "dashboard", {
      rows: rows.length,
      flagged: flagged.length,
    });
    res.json({
      rows,
      flagged_count: flagged.length,
      totals,
      grand_total: grand ? grand.total : 0,
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

  return router;
}
