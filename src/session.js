// Signed, timestamped session token — the role itsdangerous'
// URLSafeTimedSerializer plays in the Python original.
//
// Token: base64url(json) "." issued-at-seconds "." base64url(HMAC-SHA256).
// The HMAC key is derived from SESSION_SECRET and a fixed salt, so the secret
// itself never signs anything directly. Verification is constant-time and
// rejects expired and future-dated tokens.
//
// v2 (per-member accounts): the payload is { uid, role, sv } — the members.id,
// the role at issue time and the account's session_version. A new salt means
// every v1 cookie (shared-passcode era) fails verification. The token is only
// half the check: the session gate (src/auth.js) reloads the account on every
// request and rejects the token when sv or role no longer match, which is how
// logout, password changes, disabling and role changes revoke sessions.

import crypto from "node:crypto";

// __Host- makes the browser refuse the cookie unless it is Secure, Path=/ and
// has no Domain, so a sibling subdomain cannot plant or overwrite it. Plain
// http (local dev, the test suite) cannot use the prefix.
export const SESSION_COOKIE_SECURE = "__Host-pegasus_session";
export const SESSION_COOKIE_PLAIN = "pegasus_session";
const SALT = "pegasus-session-v2";

export function sessionCookieName(settings) {
  return settings.cookieSecure ? SESSION_COOKIE_SECURE : SESSION_COOKIE_PLAIN;
}

function signingKey(secret) {
  return crypto.createHmac("sha256", secret).update(SALT).digest();
}

function sign(secret, body) {
  return crypto.createHmac("sha256", signingKey(secret)).update(body).digest("base64url");
}

export function encodeToken(secret, payload, nowSeconds = Math.floor(Date.now() / 1000)) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url") + "." + nowSeconds;
  return body + "." + sign(secret, body);
}

/** Decoded payload object, or null for anything forged, expired or malformed. */
export function decodeToken(secret, token, maxAgeSeconds, nowSeconds = Math.floor(Date.now() / 1000)) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  const [payloadPart, issuedPart, signature] = parts;
  const body = payloadPart + "." + issuedPart;
  const expected = Buffer.from(sign(secret, body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;

  if (!/^\d+$/.test(issuedPart)) return null;
  const age = nowSeconds - Number(issuedPart);
  if (age < 0 || age > maxAgeSeconds) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index === -1) continue;
    if (pair.slice(0, index).trim() !== name) continue;
    let value = pair.slice(index + 1).trim();
    if (value.startsWith("\"") && value.endsWith("\"")) value = value.slice(1, -1);
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

/** Token for account `uid` with role `role` at session_version `sv`. */
export function issueSession(settings, { uid, role, sv }) {
  return encodeToken(settings.sessionSecret, { uid, role, sv });
}

/** True when the request carries a session cookie at all (valid or not). */
export function hasSessionCookie(req, settings) {
  return readCookie(req, sessionCookieName(settings)) !== null;
}

/**
 * The verified { uid, role, sv } for this request, or null when absent,
 * forged, expired, or not a v2 payload. Says nothing about whether the
 * account still accepts it — that is the session gate's job.
 */
export function readSession(req, settings) {
  const raw = readCookie(req, sessionCookieName(settings));
  if (!raw) return null;
  const payload = decodeToken(settings.sessionSecret, raw, settings.sessionMaxAgeSeconds);
  if (!payload) return null;
  const { uid, role, sv } = payload;
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(sv) || typeof role !== "string") return null;
  return { uid, role, sv };
}

function cookieOptions(settings) {
  return { httpOnly: true, sameSite: "lax", secure: settings.cookieSecure, path: "/" };
}

export function setSessionCookie(res, settings, token) {
  res.cookie(sessionCookieName(settings), token, {
    ...cookieOptions(settings),
    maxAge: settings.sessionMaxAgeSeconds * 1000,
  });
}

export function clearSessionCookie(res, settings) {
  res.clearCookie(sessionCookieName(settings), cookieOptions(settings));
}
