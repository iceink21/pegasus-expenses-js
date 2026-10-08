// Signed, timestamped session token — the role itsdangerous'
// URLSafeTimedSerializer plays in the Python original.
//
// Token: base64url(json) "." issued-at-seconds "." base64url(HMAC-SHA256).
// The HMAC key is derived from SESSION_SECRET and a fixed salt, so the secret
// itself never signs anything directly. Verification is constant-time and
// rejects expired and future-dated tokens.

import crypto from "node:crypto";

export const SESSION_COOKIE = "pegasus_session";
const SALT = "pegasus-session-v1";

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

/**
 * A team session carries the member id resolved at login; scope checks use it.
 * Admin sessions carry none.
 */
export function issueSession(settings, { team, admin, memberId = null }) {
  const payload = { team: Boolean(team), admin: Boolean(admin) };
  if (memberId !== null) payload.member_id = memberId;
  return encodeToken(settings.sessionSecret, payload);
}

/** The session payload for this request, or {} when absent/invalid. */
export function readSession(req, settings) {
  const raw = readCookie(req, SESSION_COOKIE);
  if (!raw) return {};
  return decodeToken(settings.sessionSecret, raw, settings.sessionMaxAgeSeconds) ?? {};
}

export function setSessionCookie(res, settings, token) {
  res.cookie(SESSION_COOKIE, token, {
    maxAge: settings.sessionMaxAgeSeconds * 1000,
    httpOnly: true,
    sameSite: "lax",
    secure: settings.cookieSecure,
    path: "/",
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}
