// Same-origin check on every state-changing request (CSRF defence).
//
// The session cookie is SameSite=Lax, which already keeps it off cross-site
// POSTs in current browsers; this is the second, explicit layer, and it also
// covers same-SITE attackers (a sibling subdomain) that SameSite does not.
//
// Policy for POST / PUT / PATCH / DELETE:
//   1. Origin header present → it must be this app's origin, else 403.
//      "null" (sandboxed frame, opaque redirect) is refused.
//   2. No Origin, Sec-Fetch-Site present → only "same-origin" or "none"
//      (typed into the address bar / a bookmark) pass; "same-site" and
//      "cross-site" are refused.
//   3. Neither header → allowed. Every browser that can carry a victim's
//      cookies sends at least one of them on a cross-origin POST, so a request
//      with neither comes from a non-browser client (curl, the test suite),
//      which cannot ride anyone else's session.
//
// "This app's origin": PUBLIC_ORIGIN when set (exact match). Otherwise the
// request's own Host header must match the Origin's host:port; the scheme is
// compared too when a trusted proxy reports it (X-Forwarded-Proto). Matching
// on host alone when the scheme is unknown is still safe — a browser never
// lets a page claim someone else's host in Origin — and it keeps a
// deployment behind an untrusted proxy from refusing every login.
//
// A refusal is audited here, where it is decided: auth.login.failure (reason
// csrf) for the login form, access.denied (reason csrf) for anything else.

import { AuditAction, writeAudit } from "./audit.js";
import { clientIp, fromTrustedProxy } from "./auth.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ALLOWED_FETCH_SITES = new Set(["same-origin", "none"]);

function firstValue(header) {
  return typeof header === "string" ? header.split(",")[0].trim().toLowerCase() : "";
}

/** { ok: true } or { ok: false, reason } for this request's origin evidence. */
export function checkSameOrigin(req, settings) {
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== "") {
    if (origin === "null") return { ok: false, reason: "opaque_origin" };
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return { ok: false, reason: "malformed_origin" };
    }
    if (settings.publicOrigin) {
      return parsed.origin === settings.publicOrigin ? { ok: true } : { ok: false, reason: "origin_mismatch" };
    }
    const host = (req.headers.host ?? "").toLowerCase();
    if (!host || parsed.host.toLowerCase() !== host) return { ok: false, reason: "origin_mismatch" };
    const forwardedProto = fromTrustedProxy(req, settings) ? firstValue(req.headers["x-forwarded-proto"]) : "";
    if (forwardedProto && parsed.protocol !== forwardedProto + ":") return { ok: false, reason: "origin_mismatch" };
    return { ok: true };
  }
  const fetchSite = firstValue(req.headers["sec-fetch-site"]);
  if (fetchSite && !ALLOWED_FETCH_SITES.has(fetchSite)) return { ok: false, reason: "cross_site_fetch" };
  return { ok: true };
}

export function csrfGuard(ctx) {
  const { db, settings } = ctx;
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const verdict = checkSameOrigin(req, settings);
    if (verdict.ok) {
      next();
      return;
    }
    const isLogin = req.path === "/login";
    writeAudit(db, {
      actorKind: "anonymous",
      actorName: "-",
      action: isLogin ? AuditAction.LOGIN_FAILURE : AuditAction.ACCESS_DENIED,
      subjectType: isLogin ? "account" : "route",
      subjectId: isLogin ? null : req.method + " " + req.originalUrl.split("?")[0],
      outcome: isLogin ? "failure" : "denied",
      detail: {
        reason: "csrf",
        check: verdict.reason,
        origin: String(req.headers.origin ?? "").slice(0, 200),
        sec_fetch_site: String(req.headers["sec-fetch-site"] ?? "").slice(0, 40),
      },
      clientIp: clientIp(req, settings),
    });
    res.status(403).json({ detail: "csrf_rejected" });
  };
}
