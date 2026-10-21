// Session gate and principals for per-member accounts.
//
// A signed cookie names an account (uid), the role it was issued for and the
// account's session_version (sv). The gate reloads the account on EVERY
// request and accepts the session only while the account exists, is enabled,
// and still has that sv and role — so logout, a password change or reset,
// disabling, and a role change all end existing sessions immediately, on every
// device, without any server-side session store.
//
// A session whose account must change its password (logged in with a setup
// code, or the bootstrap admin) reaches only the change-password page/API and
// logout; every other route refuses it.
//
// Every refusal is audited HERE, where it is decided (access.denied with a
// reason), before the response is sent.

import { loadAccount, Role } from "./accounts.js";
import { AuditAction, writeAudit } from "./audit.js";
import { makePrincipal } from "./permissions.js";
import { clearSessionCookie, hasSessionCookie, readSession } from "./session.js";

export const LOGIN_PATH = "/login";
export const CHANGE_PASSWORD_PATH = "/account/password";
const MEMBER_HOME = "/upload";

// Node reports IPv4 peers on a dual-stack socket as ::ffff:a.b.c.d.
function normalizePeer(address) {
  return (address ?? "").replace(/^::ffff:/, "");
}

/** True when the immediate peer is a configured trusted proxy. */
export function fromTrustedProxy(req, settings) {
  const trusted = settings.trustedProxyIps;
  if (trusted.length === 0) return false;
  return trusted.includes("*") || trusted.includes(normalizePeer(req.socket?.remoteAddress));
}

/**
 * Best-known client address for the audit row and the login rate limit.
 *
 * Forwarding headers are attacker-controlled unless our own proxy set them, so
 * they are honoured ONLY when the immediate peer is a configured trusted proxy
 * (TRUSTED_PROXY_IPS); otherwise the socket peer address is used.
 *
 * From a trusted peer:
 *   1. CLIENT_IP_HEADER set (e.g. "fly-client-ip") → that header's value. Fly's
 *      edge sets Fly-Client-IP itself, so a client cannot choose it.
 *   2. Otherwise the RIGHTMOST X-Forwarded-For entry — the one our proxy
 *      appended. Everything left of it came from the client and is forgeable;
 *      taking the leftmost would let any client pick its own audit IP and a
 *      fresh rate-limit bucket per request.
 */
export function clientIp(req, settings) {
  const peer = normalizePeer(req.socket?.remoteAddress);
  if (!fromTrustedProxy(req, settings)) return peer;
  if (settings.clientIpHeader) {
    const value = req.headers[settings.clientIpHeader];
    const single = typeof value === "string" ? value.trim() : "";
    return single || peer;
  }
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    const entries = forwarded.split(",").map((entry) => entry.trim()).filter(Boolean);
    if (entries.length > 0) return entries.at(-1);
  }
  return peer;
}

function routeId(req) {
  return req.method + " " + req.originalUrl.split("?")[0];
}

/** Why the session on this request is not usable, or null with the account. */
function resolveSession(req, ctx) {
  const session = readSession(req, ctx.settings);
  if (!session) {
    return { account: null, reason: hasSessionCookie(req, ctx.settings) ? "invalid_session" : "no_session" };
  }
  const account = loadAccount(ctx.db, session.uid);
  if (!account) return { account: null, reason: "unknown_account" };
  if (account.disabled) return { account, reason: "account_disabled" };
  if (account.sessionVersion !== session.sv) return { account, reason: "session_revoked" };
  if (account.role !== session.role) return { account, reason: "role_changed" };
  return { account, reason: null };
}

/**
 * The live account behind this request's session, or null. For routes that
 * act on a session without gating on it (logout, the root redirect).
 */
export function currentAccount(req, ctx) {
  const { account, reason } = resolveSession(req, ctx);
  return reason === null ? account : null;
}

function sessionGate(ctx, { level, mode, allowMustChange }) {
  return (req, res, next) => {
    const { account, reason: sessionProblem } = resolveSession(req, ctx);
    let reason = sessionProblem;
    if (reason === null && account.mustChangePassword && !allowMustChange) reason = "must_change_password";
    if (reason === null && level === "admin" && account.role !== Role.ADMIN) reason = "not_admin";
    if (reason === null) {
      req.pegasusAccount = account;
      next();
      return;
    }

    // DECISION POINT: audited before any response is written.
    writeAudit(ctx.db, {
      actorKind: account ? account.role : "anonymous",
      actorName: account ? account.name : "-",
      action: AuditAction.ACCESS_DENIED,
      subjectType: "route",
      subjectId: routeId(req),
      outcome: "denied",
      detail: { reason },
      clientIp: clientIp(req, ctx.settings),
    });

    if (reason === "must_change_password") {
      if (mode === "page") res.redirect(303, CHANGE_PASSWORD_PATH);
      else res.status(403).json({ detail: "password_change_required", location: CHANGE_PASSWORD_PATH });
      return;
    }
    if (reason === "not_admin") {
      // Logged in, just not allowed here: no point sending them to log in.
      if (mode === "page") res.redirect(303, MEMBER_HOME);
      else res.status(403).json({ detail: "admin_required" });
      return;
    }
    // No usable session. A revoked/forged cookie is dropped so the browser
    // stops sending it.
    if (hasSessionCookie(req, ctx.settings)) clearSessionCookie(res, ctx.settings);
    if (mode === "page") {
      res.redirect(303, LOGIN_PATH);
      return;
    }
    res.status(401).json({ detail: "login_required", location: LOGIN_PATH });
  };
}

/** Any logged-in account (member or admin). */
export function requireMember(ctx, mode, { allowMustChange = false } = {}) {
  return sessionGate(ctx, { level: "member", mode, allowMustChange });
}

/** Accounts with role admin only. */
export function requireAdmin(ctx, mode) {
  return sessionGate(ctx, { level: "admin", mode, allowMustChange: false });
}

/**
 * Principal for a request that passed a gate: the account bound to the
 * session. Nothing in the request body can change who that is.
 */
export function memberPrincipal(req, settings) {
  const account = req.pegasusAccount;
  if (!account) throw new Error("memberPrincipal used on a route without a session gate");
  return makePrincipal({
    kind: account.role,
    name: account.name,
    memberId: account.id,
    username: account.username,
    clientIp: clientIp(req, settings),
  });
}

/** Same as memberPrincipal; reads better on routes behind requireAdmin. */
export const adminPrincipal = memberPrincipal;
