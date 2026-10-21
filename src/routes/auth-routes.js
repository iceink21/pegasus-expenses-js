// Login, logout and password change for per-member accounts.
//
// One login for everyone: username + password (or the one-time setup code an
// admin issued). The role stored on the account decides what the session may
// do. There is no self-registration and login never creates a member.
//
// POST /login, in order — each refusal audited where it is decided:
//   1. per-IP token bucket            → 429 rate_limited
//   2. unknown username               → 401 bad_credentials (after a dummy hash)
//   3. account locked                 → 423 account_locked
//   4. wrong password / expired code  → 401 bad_credentials (+ lockout count)
//   5. account disabled               → 403 account_disabled (only after a
//                                       correct password, so it reveals nothing
//                                       to a guesser)
// Steps 2 and 4 send byte-identical bodies and cost one scrypt each.

import express from "express";

import {
  changePassword,
  findAccountByUsername,
  isLocked,
  isValidUsername,
  loadAccount,
  normalizeUsername,
  recordLoginFailure,
  recordLoginSuccess,
  bumpSessionVersion,
  verifyCredential,
  Role,
} from "../accounts.js";
import { AuditAction, writeAudit } from "../audit.js";
import { CHANGE_PASSWORD_PATH, clientIp, currentAccount, LOGIN_PATH, memberPrincipal, requireMember } from "../auth.js";
import { HttpError } from "../http-error.js";
import { clearSessionCookie, hasSessionCookie, issueSession, setSessionCookie } from "../session.js";
import { sendPage, wantsJson } from "./http.js";

const BODY_LIMIT = "8kb";
const USERNAME_AUDIT_MAX = 32;

function homeFor(account) {
  if (account.mustChangePassword) return CHANGE_PASSWORD_PATH;
  return account.role === Role.ADMIN ? "/admin" : "/upload";
}

function bodyString(body, name) {
  const value = body?.[name];
  return typeof value === "string" ? value : "";
}

/** JSON for the page scripts, a 303 for plain form posts and other clients. */
function respondWithLocation(req, res, location) {
  if (wantsJson(req)) {
    res.json({ location });
    return;
  }
  res.redirect(303, location);
}

export function createAuthRouter(ctx) {
  const { db, settings, passwords, loginLimiter } = ctx;
  const router = express.Router();
  const parseBody = [
    express.urlencoded({ extended: false, limit: BODY_LIMIT }),
    express.json({ limit: BODY_LIMIT, strict: true }),
  ];

  const issueCookie = (res, account) =>
    setSessionCookie(res, settings, issueSession(settings, { uid: account.id, role: account.role, sv: account.sessionVersion }));

  router.get("/", (req, res) => {
    const account = currentAccount(req, ctx);
    res.redirect(303, account ? homeFor(account) : LOGIN_PATH);
  });

  router.get(LOGIN_PATH, (req, res) => sendPage(res, "login.html"));

  // The separate admin login is gone: admins are accounts with role admin.
  router.get("/admin/login", (req, res) => res.redirect(303, LOGIN_PATH));
  router.post("/admin/login", (req, res) => res.redirect(303, LOGIN_PATH));

  router.post(LOGIN_PATH, parseBody, async (req, res) => {
    const ip = clientIp(req, settings);
    const userAgent = (req.get("user-agent") ?? "").slice(0, 200);
    const username = normalizeUsername(bodyString(req.body, "username"));
    const password = bodyString(req.body, "password");
    // Only something shaped like a username is recorded: people type their
    // password into the username box, and that must not land in the log.
    const auditUsername = isValidUsername(username) ? username.slice(0, USERNAME_AUDIT_MAX) : "(invalid)";
    const fail = (reason, account = null, extra = {}) =>
      writeAudit(db, {
        actorKind: "anonymous",
        actorName: auditUsername,
        action: AuditAction.LOGIN_FAILURE,
        subjectType: "account",
        subjectId: account ? account.id : null,
        outcome: "failure",
        detail: { reason, username: auditUsername, user_agent: userAgent, ...extra },
        clientIp: ip,
      });
    const badCredentials = () => res.status(401).json({ detail: "bad_credentials" });

    const limit = loginLimiter.take(ip);
    if (!limit.allowed) {
      fail("rate_limited");
      res.set("Retry-After", String(limit.retryAfterSeconds)).status(429).json({ detail: "rate_limited" });
      return;
    }

    const account = isValidUsername(username) ? findAccountByUsername(db, username) : null;
    if (!account) {
      await passwords.burn();
      fail("bad_credentials", null, { cause: "unknown_user" });
      badCredentials();
      return;
    }
    if (isLocked(account)) {
      fail("locked", account, { locked_until: account.lockedUntil });
      res.status(423).json({ detail: "account_locked" });
      return;
    }

    const checked = await verifyCredential(passwords, account, password);
    if (!checked.ok) {
      const lockout = recordLoginFailure(db, settings, account.id, { clientIp: ip });
      fail("bad_credentials", account, { cause: checked.cause, locked_now: lockout.lockedNow });
      badCredentials();
      return;
    }
    if (account.disabled) {
      fail("disabled", account);
      res.status(403).json({ detail: "account_disabled" });
      return;
    }
    // The verify awaited; make sure the credential it checked is still the
    // account's (not reset or changed meanwhile) and the account still usable.
    const fresh = loadAccount(db, account.id);
    const stillCurrent =
      fresh && !fresh.disabled && !isLocked(fresh) && (fresh.passwordHash ?? fresh.setupCodeHash) === checked.hash;
    if (!stillCurrent) {
      fail("bad_credentials", account, { cause: "credential_changed" });
      badCredentials();
      return;
    }

    recordLoginSuccess(db, fresh.id);
    writeAudit(db, {
      actorKind: fresh.role,
      actorName: fresh.name,
      action: AuditAction.LOGIN_SUCCESS,
      subjectType: "account",
      subjectId: fresh.id,
      outcome: "success",
      detail: { username: fresh.username, via: checked.kind, must_change_password: fresh.mustChangePassword, user_agent: userAgent },
      clientIp: ip,
    });
    issueCookie(res, fresh);
    respondWithLocation(req, res, homeFor(fresh));
  });

  // Logout ends the session on EVERY device (session_version bump).
  router.post("/logout", (req, res) => {
    const account = currentAccount(req, ctx);
    if (account) {
      bumpSessionVersion(db, account.id);
      writeAudit(db, {
        actorKind: account.role,
        actorName: account.name,
        action: AuditAction.LOGOUT,
        subjectType: "account",
        subjectId: account.id,
        outcome: "success",
        detail: { username: account.username, all_devices: true },
        clientIp: clientIp(req, settings),
      });
    }
    if (account || hasSessionCookie(req, settings)) clearSessionCookie(res, settings);
    respondWithLocation(req, res, LOGIN_PATH);
  });

  // A GET must not change state: this is a page whose button POSTs /logout.
  router.get("/logout", (req, res) => sendPage(res, "logout.html"));

  router.get(CHANGE_PASSWORD_PATH, requireMember(ctx, "page", { allowMustChange: true }), (req, res) =>
    sendPage(res, "change-password.html"),
  );

  router.get("/api/account", requireMember(ctx, "api", { allowMustChange: true }), (req, res) => {
    const account = req.pegasusAccount;
    res.set("Cache-Control", "no-store").json({
      id: account.id,
      username: account.username,
      name: account.name,
      role: account.role,
      must_change_password: account.mustChangePassword,
      // While on a setup code, the "current password" box takes the code.
      using_setup_code: account.passwordHash === null,
    });
  });

  router.post(
    "/api/account/password",
    requireMember(ctx, "api", { allowMustChange: true }),
    parseBody,
    async (req, res) => {
      const current = bodyString(req.body, "current_password");
      const next = bodyString(req.body, "new_password");
      if (current === "") throw new HttpError(400, "current_password_required");
      const principal = memberPrincipal(req, settings);
      const updated = await changePassword(db, passwords, settings, req.pegasusAccount, { current, next }, principal);
      // Every other session of this account just ended; this device continues.
      issueCookie(res, updated);
      res.json({ location: homeFor(updated) });
    },
  );

  return router;
}
