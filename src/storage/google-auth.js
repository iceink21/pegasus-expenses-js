// OAuth2 access tokens for a Google service account (JWT bearer grant, RFC 7523).
//
// This is the small slice of google-auth the Drive backend needs, done with
// node:crypto + fetch so the app carries no Google SDK dependency.

import crypto from "node:crypto";

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const TOKEN_LIFETIME_SECONDS = 3600;
const REFRESH_MARGIN_SECONDS = 60;

const b64url = (value) => Buffer.from(value).toString("base64url");

export function buildJwtAssertion(info, scopes, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: info.client_email,
    scope: scopes.join(" "),
    aud: info.token_uri || DEFAULT_TOKEN_URI,
    iat: nowSeconds,
    exp: nowSeconds + TOKEN_LIFETIME_SECONDS,
  };
  const unsigned = b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(claims));
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(info.private_key);
  return unsigned + "." + b64url(signature);
}

/** Caches one access token and refreshes it shortly before it expires. */
export class ServiceAccountTokenSource {
  constructor(info, scopes, fetchImpl = fetch) {
    this.info = info;
    this.scopes = scopes;
    this.fetchImpl = fetchImpl;
    this.cached = null;
  }

  async accessToken() {
    const now = Math.floor(Date.now() / 1000);
    if (this.cached && this.cached.expiresAt - REFRESH_MARGIN_SECONDS > now) {
      return this.cached.token;
    }
    const response = await this.fetchImpl(this.info.token_uri || DEFAULT_TOKEN_URI, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: buildJwtAssertion(this.info, this.scopes, now),
      }),
    });
    if (!response.ok) throw new Error("service-account token request failed: HTTP " + response.status);
    const body = await response.json();
    this.cached = {
      token: body.access_token,
      expiresAt: now + Number(body.expires_in ?? TOKEN_LIFETIME_SECONDS),
    };
    return this.cached.token;
  }
}
