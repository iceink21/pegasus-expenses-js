// Shared-passcode auth: team passcode + name-select, plus a separate admin password.
//
// There are no per-user accounts. The team passcode exists so the upload URL is
// not a public write endpoint if the link leaks into a LINE group; the member
// name is then chosen per upload from a fixed dropdown.
//
// Comparison is hash-then-constant-time: both sides are SHA-256 digested and
// compared with timingSafeEqual, so neither length nor content leaks by timing.

import crypto from "node:crypto";

import { AuditAction, writeAudit } from "./audit.js";
import { HttpError } from "./http-error.js";
import { makePrincipal } from "./permissions.js";
import { readSession } from "./session.js";

export function verifySecret(candidate, expected) {
  const candidateDigest = crypto.createHash("sha256").update(candidate ?? "", "utf8").digest();
  const expectedDigest = crypto.createHash("sha256").update(expected ?? "", "utf8").digest();
  return crypto.timingSafeEqual(candidateDigest, expectedDigest);
}

// Node reports IPv4 peers on a dual-stack socket as ::ffff:a.b.c.d.
function normalizePeer(address) {
  return (address ?? "").replace(/^::ffff:/, "");
}

/**
 * Best-known client address for the audit row.
 *
 * X-Forwarded-For is attacker-controlled: any client can send one. Believing
 * it unconditionally means every IP in the audit log is forgeable, which
 * quietly destroys the value of the log. So it is honoured ONLY when the
 * immediate peer is a configured trusted proxy (TRUSTED_PROXY_IPS), and the
 * direct peer address is used otherwise.
 */
export function clientIp(req, settings) {
  const peer = normalizePeer(req.socket?.remoteAddress);
  const trusted = settings.trustedProxyIps;
  if (trusted.length === 0) return peer;
  if (!trusted.includes("*") && !trusted.includes(peer)) return peer;
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return peer;
}

const LOGIN_PATH = { team: "/login", admin: "/admin/login" };

/**
 * Session gate for pages (`mode: "page"` → 303 to the login page, as the
 * Python dependency did) and for JSON endpoints (`mode: "api"` → 401 with the
 * login path, so the browser script can navigate there itself).
 *
 * The denial is audited HERE, where it is decided. The Python dependency
 * redirected without writing a row; this port closes that gap.
 */
function sessionGate(ctx, level, mode) {
  return (req, res, next) => {
    const session = readSession(req, ctx.settings);
    const allowed = level === "admin" ? session.admin : session.team || session.admin;
    if (allowed) {
      req.pegasusSession = session;
      next();
      return;
    }
    writeAudit(ctx.db, {
      actorKind: session.team ? "member" : "anonymous",
      actorName: "-",
      action: AuditAction.ACCESS_DENIED,
      subjectType: "route",
      subjectId: req.method + " " + req.originalUrl.split("?")[0],
      outcome: "denied",
      detail: { reason: level === "admin" ? "no_admin_session" : "no_team_session" },
      clientIp: clientIp(req, ctx.settings),
    });
    const location = LOGIN_PATH[level];
    if (mode === "page") {
      res.redirect(303, location);
      return;
    }
    res.status(401).json({ detail: "login_required", location });
  };
}

/** Any valid session (team or admin) may reach member pages. */
export function requireTeam(ctx, mode) {
  return sessionGate(ctx, "team", mode);
}

/** Admin pages need the admin password session. */
export function requireAdmin(ctx, mode) {
  return sessionGate(ctx, "admin", mode);
}

export function adminPrincipal(req, settings) {
  return makePrincipal({ kind: "admin", name: "admin", clientIp: clientIp(req, settings) });
}

/** Principal for a member action. The name must be on the roster. */
export function memberPrincipal(req, settings, name) {
  const session = req.pegasusSession ?? readSession(req, settings);
  if (session.admin) {
    // An admin acting on the member page still records the chosen name, but
    // keeps admin scope.
    return makePrincipal({ kind: "admin", name: name || "admin", clientIp: clientIp(req, settings) });
  }
  if (!settings.members.includes(name)) throw new HttpError(400, "unknown_member");
  return makePrincipal({ kind: "member", name, clientIp: clientIp(req, settings) });
}
