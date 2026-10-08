// Shared-passcode auth: team passcode + typed name, plus a separate admin password.
//
// There are no per-user accounts. The team passcode exists so the upload URL is
// not a public write endpoint if the link leaks into a LINE group. At login the
// visitor also types their name; it is resolved to a members row (created if
// new) and that member id is sealed into the signed session. Every later
// member-scoped check uses that id. Knowing the passcode is still enough to
// log in under any name: see README §3.
//
// Comparison is hash-then-constant-time: both sides are SHA-256 digested and
// compared with timingSafeEqual, so neither length nor content leaks by timing.

import crypto from "node:crypto";

import { AuditAction, writeAudit } from "./audit.js";
import { loadMember } from "./members.js";
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
    let allowed = Boolean(session.admin);
    let reason = level === "admin" ? "no_admin_session" : "no_team_session";
    let member = null;
    if (level === "team" && !session.admin && session.team) {
      // A team session must name an existing member. Cookies issued before
      // typed names (no member_id) send the person back to log in again.
      member = Number.isSafeInteger(session.member_id) ? loadMember(ctx.db, session.member_id) : null;
      allowed = member !== null;
      reason = "no_member_identity";
    }
    if (allowed) {
      req.pegasusSession = session;
      req.pegasusMember = member;
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
      detail: { reason },
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

/**
 * Principal for a request that passed requireTeam. A team session acts as the
 * member bound at login; nothing in the request can change who that is.
 */
export function memberPrincipal(req, settings) {
  const session = req.pegasusSession ?? {};
  if (session.admin) return adminPrincipal(req, settings);
  const member = req.pegasusMember;
  if (!member) throw new Error("memberPrincipal used on a route without requireTeam");
  return makePrincipal({
    kind: "member",
    name: member.name,
    memberId: member.id,
    clientIp: clientIp(req, settings),
  });
}
