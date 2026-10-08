// Member-facing upload flow.
//
// The browser posts an image plus a claimed amount. It does NOT post a verdict
// and no request field can influence one — the server alone decides, in
// decision.js.

import express from "express";
import multer from "multer";

import { memberPrincipal, requireTeam } from "../auth.js";
import { statement } from "../db/connection.js";
import { SELECT_EXPENSES_BY_MEMBER } from "../db/sql.js";
import { decisionView, loadExpense, recordSubmission } from "../decision.js";
import { HttpError } from "../http-error.js";
import { parsePyFloat, pyRound2 } from "../../shared/numbers.js";
import { Action, requireAccess, requirePermission } from "../permissions.js";
import { enforce, queryString, requiredField, sendPage } from "./http.js";

const RECENT_LIMIT = 20;
const NUMERIC_CLEANUP = /[,\s฿]/gu;
const MAX_AMOUNT = 10_000_000;
const NOTE_MAX_CHARS = 500;
const INTEGER_ID = /^[+-]?\d+$/;

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

function resultUrl(expenseId, memberName) {
  return "/result?" + new URLSearchParams({ id: String(expenseId), member: memberName });
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
    router.get(path, requireTeam(ctx, "page"), (req, res) => sendPage(res, page));
  }

  router.get("/api/upload-form", requireTeam(ctx, "api"), (req, res) => {
    res.json({
      members: settings.members,
      categories: settings.categories,
      using_stub_ocr: providers.usingStubOcr,
    });
  });

  router.post("/upload", requireTeam(ctx, "api"), slipUpload, async (req, res) => {
    const memberName = requiredField(req.body, "member_name");
    const category = requiredField(req.body, "category");
    const claimedRaw = requiredField(req.body, "claimed_amount");
    if (!req.file) throw new HttpError(422, "missing_field", { field: "slip" });

    const principal = memberPrincipal(req, settings, memberName);
    const amount = parseAmount(claimedRaw);
    if (!settings.categories.includes(category)) throw new HttpError(400, "unknown_category");

    // Oversize files never get here: multer stops at MAX_UPLOAD_BYTES (413).
    const imageBytes = req.file.buffer;
    if (imageBytes.length === 0) throw new HttpError(400, "empty_file");

    enforce(() => requirePermission(db, principal, Action.EXPENSE_CREATE));

    const note = typeof req.body.note === "string" ? req.body.note : "";
    const decision = await recordSubmission(db, {
      principal,
      settings,
      providers,
      memberName: principal.name,
      category,
      note: [...note.trim()].slice(0, NOTE_MAX_CHARS).join(""),
      claimedAmount: amount,
      imageBytes,
      filename: req.file.originalname || "slip",
      contentType: req.file.mimetype || "application/octet-stream",
    });

    res.json({
      decision,
      member_name: principal.name,
      category,
      using_stub_ocr: providers.usingStubOcr,
      result_url: resultUrl(decision.expense_id, principal.name),
    });
  });

  router.get("/api/my", requireTeam(ctx, "api"), (req, res) => {
    const member = queryString(req, "member");
    let rows = [];
    if (member) {
      const principal = memberPrincipal(req, settings, member);
      enforce(() => requirePermission(db, principal, Action.EXPENSE_READ_OWN));
      // SCOPE applied in the query itself.
      rows = statement(db, SELECT_EXPENSES_BY_MEMBER).all(principal.name, RECENT_LIMIT);
    }
    res.json({ member, members: settings.members, rows });
  });

  router.get("/api/expenses/:id", requireTeam(ctx, "api"), (req, res) => {
    if (!INTEGER_ID.test(req.params.id)) throw new HttpError(422, "invalid_id");
    const principal = memberPrincipal(req, settings, queryString(req, "member"));
    const row = loadExpense(db, Number(req.params.id));
    if (!row) throw new HttpError(404, "not_found");
    enforce(() => {
      requirePermission(db, principal, Action.EXPENSE_READ_OWN);
      // SCOPE gate on read, not only on list queries.
      requireAccess(db, principal, row, Action.EXPENSE_READ_OWN);
    });
    res.json({
      expense: row,
      view: decisionView(row, settings),
      using_stub_ocr: providers.usingStubOcr,
    });
  });

  return router;
}
