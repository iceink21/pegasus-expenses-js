// Admin account management: list, create, issue setup code (reset), unlock,
// disable/enable, change role, rename, change username.
//
// Every route is behind requireAdmin AND requirePermission(MEMBER_MANAGE), so
// a member session is refused (and audited) twice over. A setup code appears
// in exactly one place — the JSON body of the response to the request that
// created it, marked no-store — and nowhere else: not the audit log, not a
// log line, not a later list call.

import express from "express";

import {
  accountSummary,
  changeUsername,
  createAccount,
  issueSetupCode,
  listAccounts,
  loadAccount,
  renameAccount,
  setAccountDisabled,
  setAccountRole,
  unlockAccount,
} from "../accounts.js";
import { AuditAction, writeAudit } from "../audit.js";
import { adminPrincipal, requireAdmin } from "../auth.js";
import { HttpError } from "../http-error.js";
import { Action, requirePermission } from "../permissions.js";
import { INTEGER_ID } from "./expenses.js";
import { enforce, sendPage } from "./http.js";

const BODY_LIMIT = "4kb";

function targetId(req) {
  if (!INTEGER_ID.test(req.params.id)) throw new HttpError(422, "invalid_id");
  return Number(req.params.id);
}

function jsonBody(req) {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_body");
  return body;
}

export function createAdminMembersRouter(ctx) {
  const { db, settings, passwords } = ctx;
  const router = express.Router();
  const json = express.json({ limit: BODY_LIMIT, strict: true });

  /** Gate + permission for every API route; returns the acting principal. */
  const manager = (req) => {
    const principal = adminPrincipal(req, settings);
    enforce(() => requirePermission(db, principal, Action.MEMBER_MANAGE));
    return principal;
  };
  const summary = (account) => accountSummary(account);
  const noStore = (res) => res.set("Cache-Control", "no-store");

  router.get("/admin/members", requireAdmin(ctx, "page"), (req, res) => sendPage(res, "admin-members.html"));

  router.get("/api/admin/members", requireAdmin(ctx, "api"), (req, res) => {
    const principal = manager(req);
    const members = listAccounts(db).map(summary);
    writeAudit(db, {
      actorKind: principal.kind,
      actorName: principal.name,
      action: AuditAction.ADMIN_VIEW_MEMBERS,
      subjectType: "admin",
      subjectId: "members",
      outcome: "success",
      detail: { rows: members.length },
      clientIp: principal.clientIp,
    });
    noStore(res).json({ members, self_id: principal.memberId });
  });

  router.post("/api/admin/members", requireAdmin(ctx, "api"), json, async (req, res) => {
    const principal = manager(req);
    const body = jsonBody(req);
    const { account, setupCode, expiresAt } = await createAccount(
      db,
      passwords,
      settings,
      { username: body.username, name: body.name, role: body.role ?? "member" },
      principal,
    );
    noStore(res).status(201).json({ member: summary(account), setup_code: setupCode, setup_code_expires_at: expiresAt });
  });

  router.post("/api/admin/members/:id/setup-code", requireAdmin(ctx, "api"), async (req, res) => {
    const principal = manager(req);
    const id = targetId(req);
    const { setupCode, expiresAt } = await issueSetupCode(db, passwords, settings, id, principal);
    noStore(res).json({ member: summary(loadAccount(db, id)), setup_code: setupCode, setup_code_expires_at: expiresAt });
  });

  router.post("/api/admin/members/:id/unlock", requireAdmin(ctx, "api"), (req, res) => {
    const principal = manager(req);
    noStore(res).json({ member: summary(unlockAccount(db, targetId(req), principal)) });
  });

  for (const [path, disabled] of [["disable", true], ["enable", false]]) {
    router.post("/api/admin/members/:id/" + path, requireAdmin(ctx, "api"), (req, res) => {
      const principal = manager(req);
      noStore(res).json({ member: summary(setAccountDisabled(db, targetId(req), disabled, principal)) });
    });
  }

  router.post("/api/admin/members/:id/role", requireAdmin(ctx, "api"), json, (req, res) => {
    const principal = manager(req);
    const id = targetId(req);
    const { role } = jsonBody(req);
    noStore(res).json({ member: summary(setAccountRole(db, id, role, principal)) });
  });

  router.post("/api/admin/members/:id/name", requireAdmin(ctx, "api"), json, (req, res) => {
    const principal = manager(req);
    const id = targetId(req);
    const { name } = jsonBody(req);
    noStore(res).json({ member: summary(renameAccount(db, id, name, principal)) });
  });

  router.post("/api/admin/members/:id/username", requireAdmin(ctx, "api"), json, (req, res) => {
    const principal = manager(req);
    const id = targetId(req);
    const { username } = jsonBody(req);
    noStore(res).json({ member: summary(changeUsername(db, id, username, principal)) });
  });

  return router;
}
