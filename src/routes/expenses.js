// Member-facing upload flow.
//
// The browser posts an image plus a claimed amount. It does NOT post a verdict
// and no request field can influence one — the server alone decides, in
// decision.js.
//
// Who submits: a member session acts as its own account; any member_name or
// member_id field it sends is ignored. An admin session submits for an
// EXISTING member chosen by member_id (default: the admin themself). Uploading
// never creates a member — accounts are created on the members page.
//
// What comes back: a member session gets the member-safe projection from
// views.js and nothing about the verdict. An admin session gets everything.

import express from "express";
import multer from "multer";

import { loadAccount } from "../accounts.js";
import { memberPrincipal, requireMember } from "../auth.js";
import { statement } from "../db/connection.js";
import { SELECT_EXPENSES_BY_MEMBER_ID, SELECT_MEMBER_CHOICES } from "../db/sql.js";
import { decisionView, loadExpense, recordSubmission } from "../decision.js";
import { HttpError } from "../http-error.js";
import { findMemberByName, listMemberNames } from "../members.js";
import { parsePyFloat, pyRound2 } from "../../shared/numbers.js";
import { Action, requireAccess, requirePermission } from "../permissions.js";
import { memberExpenseView } from "../views.js";
import { enforce, queryString, requiredField, sendPage } from "./http.js";

const RECENT_LIMIT = 20;
const NUMERIC_CLEANUP = /[,\s฿]/gu;
export const MAX_AMOUNT = 10_000_000;
export const NOTE_MAX_CHARS = 500;
export const INTEGER_ID = /^[+-]?\d+$/;

export function parseAmount(raw) {
  const text = String(raw ?? "").replace(NUMERIC_CLEANUP, "");
  if (!text) throw new HttpError(400, "amount_required");
  const value = parsePyFloat(text);
  // Python accepted "nan" here and then failed on the NOT NULL insert (500);
  // it is rejected up front instead.
  if (value === null || Number.isNaN(value)) throw new HttpError(400, "amount_not_a_number");
  if (value <= 0) throw new HttpError(400, "amount_must_be_positive");
  if (value > MAX_AMOUNT) throw new HttpError(400, "amount_out_of_range");
  return pyRound2(value);
}

function resultUrl(expenseId) {
  return "/result?" + new URLSearchParams({ id: String(expenseId) });
}

export function createExpensesRouter(ctx) {
  const { db, settings, providers } = ctx;
  const router = express.Router();
  const slipUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: settings.maxUploadBytes, files: 1 },
    defParamCharset: "utf8",
  }).single("slip");

  for (const [path, page] of [
    ["/upload", "upload.html"],
    ["/result", "result.html"],
    ["/my", "my.html"],
    ["/expenses/:id", "expense.html"],
  ]) {
    router.get(path, requireMember(ctx, "page"), (req, res) => sendPage(res, page));
  }

  router.get("/api/upload-form", requireMember(ctx, "api"), (req, res) => {
    const principal = memberPrincipal(req, settings);
    if (!principal.isAdmin) {
      res.json({ detail_level: "member", member: { name: principal.name }, categories: settings.categories });
      return;
    }
    res.json({
      detail_level: "admin",
      member: null,
      // Existing members to submit for; the admin's own id is the default.
      members: statement(db, SELECT_MEMBER_CHOICES).all().map((row) => ({ id: Number(row.id), name: String(row.name) })),
      self_id: principal.memberId,
      categories: settings.categories,
      using_stub_ocr: providers.usingStubOcr,
    });
  });

  router.post("/upload", requireMember(ctx, "api"), slipUpload, async (req, res) => {
    const category = requiredField(req.body, "category");
    const claimedRaw = requiredField(req.body, "claimed_amount");
    if (!req.file) throw new HttpError(422, "missing_field", { field: "slip" });

    const principal = memberPrincipal(req, settings);
    const amount = parseAmount(claimedRaw);
    if (!settings.categories.includes(category)) throw new HttpError(400, "unknown_category");

    // Oversize files never get here: multer stops at MAX_UPLOAD_BYTES (413).
    const imageBytes = req.file.buffer;
    if (imageBytes.length === 0) throw new HttpError(400, "empty_file");

    enforce(() => requirePermission(db, principal, Action.EXPENSE_CREATE));

    let member = { id: principal.memberId, name: principal.name };
    if (principal.isAdmin) {
      const raw = typeof req.body.member_id === "string" ? req.body.member_id.trim() : "";
      if (raw !== "") {
        if (!INTEGER_ID.test(raw)) throw new HttpError(422, "invalid_member_id");
        const chosen = loadAccount(db, Number(raw));
        if (!chosen) throw new HttpError(400, "unknown_member");
        member = { id: chosen.id, name: chosen.name };
      }
    }

    const note = typeof req.body.note === "string" ? req.body.note : "";
    const decision = await recordSubmission(db, {
      principal,
      settings,
      providers,
      memberId: member.id,
      memberName: member.name,
      category,
      note: [...note.trim()].slice(0, NOTE_MAX_CHARS).join(""),
      claimedAmount: amount,
      imageBytes,
      filename: req.file.originalname || "slip",
      contentType: req.file.mimetype || "application/octet-stream",
    });

    if (!principal.isAdmin) {
      res.json({
        detail_level: "member",
        status: "received",
        expense: memberExpenseView(loadExpense(db, decision.expense_id)),
        result_url: resultUrl(decision.expense_id),
      });
      return;
    }
    res.json({
      detail_level: "admin",
      decision,
      member_name: member.name,
      category,
      using_stub_ocr: providers.usingStubOcr,
      result_url: resultUrl(decision.expense_id),
    });
  });

  router.get("/api/my", requireMember(ctx, "api"), (req, res) => {
    const principal = memberPrincipal(req, settings);
    enforce(() => requirePermission(db, principal, Action.EXPENSE_READ_OWN));
    if (!principal.isAdmin) {
      // SCOPE applied in the query itself, by the session's member id.
      const rows = statement(db, SELECT_EXPENSES_BY_MEMBER_ID).all(principal.memberId, RECENT_LIMIT);
      res.json({ detail_level: "member", member: { name: principal.name }, rows: rows.map(memberExpenseView) });
      return;
    }
    // Admin: look a member up by typed name. A read never creates a member.
    const typed = queryString(req, "member");
    const found = typed ? findMemberByName(db, typed) : null;
    const rows = found ? statement(db, SELECT_EXPENSES_BY_MEMBER_ID).all(found.id, RECENT_LIMIT) : [];
    res.json({
      detail_level: "admin",
      member: found ? { name: found.name } : null,
      query: typed,
      member_names: listMemberNames(db),
      rows,
    });
  });

  router.get("/api/expenses/:id", requireMember(ctx, "api"), (req, res) => {
    if (!INTEGER_ID.test(req.params.id)) throw new HttpError(422, "invalid_id");
    const principal = memberPrincipal(req, settings);
    const row = loadExpense(db, Number(req.params.id));
    if (!row) throw new HttpError(404, "not_found");
    enforce(() => {
      requirePermission(db, principal, Action.EXPENSE_READ_OWN);
      // SCOPE gate on read, not only on list queries.
      requireAccess(db, principal, row, Action.EXPENSE_READ_OWN);
    });
    if (!principal.isAdmin) {
      res.json({ detail_level: "member", expense: memberExpenseView(row) });
      return;
    }
    res.json({
      detail_level: "admin",
      expense: row,
      view: decisionView(row, settings),
      using_stub_ocr: providers.usingStubOcr,
    });
  });

  return router;
}
