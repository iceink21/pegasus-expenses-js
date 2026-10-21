// Port of tests/test_startup_guard.py — the app must not be able to SERVE with
// repo-published default secrets. QC once minted a full admin session using
// nothing but the values committed in config; these tests are the standing
// proof that path is closed.

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildApp } from "../src/app.js";
import { clientIp } from "../src/auth.js";
import {
  assertSecureConfig,
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_SESSION_SECRET,
  InsecureDefaultsError,
  loadSettings,
} from "../src/config.js";
import { VISION_ENDPOINT, VisionOCRExtractor } from "../src/extraction/vision.js";
import { query, testEnv } from "./helpers.js";

const DEFAULT_SECRETS = { ADMIN_PASSWORD: undefined, SESSION_SECRET: undefined };

test("settings can still be built with the defaults", () => {
  // Building settings is free — only SERVING is gated.
  const settings = loadSettings({});
  assert.equal(settings.adminPassword, DEFAULT_ADMIN_PASSWORD);
  assert.equal(settings.sessionSecret, DEFAULT_SESSION_SECRET);
  assert.equal(settings.teamPasscodeSet, false);
});

test("the guard rejects every published default that would be used", () => {
  const settings = loadSettings(testEnv({ ...DEFAULT_SECRETS, ALLOW_INSECURE_DEFAULTS: "0" }));
  assert.throws(
    () => assertSecureConfig(settings),
    (error) => {
      assert.ok(error instanceof InsecureDefaultsError);
      // The error must name WHICH vars are wrong, not just "insecure config".
      for (const name of ["ADMIN_PASSWORD", "SESSION_SECRET", "ALLOW_INSECURE_DEFAULTS"]) {
        assert.ok(error.message.includes(name), name);
      }
      // The retired team passcode is no longer a secret of this app.
      assert.ok(!error.message.includes("TEAM_PASSCODE"));
      return true;
    },
  );
});

test("the guard names only the offending variable", () => {
  const settings = loadSettings(
    testEnv({
      ADMIN_PASSWORD: "a-real-admin-password",
      SESSION_SECRET: undefined, // only this one left at its default
      ALLOW_INSECURE_DEFAULTS: "0",
    }),
  );
  assert.throws(
    () => assertSecureConfig(settings),
    (error) => error.message.includes("SESSION_SECRET") && !error.message.includes("ADMIN_PASSWORD"),
  );
});

test("a default ADMIN_PASSWORD only blocks while it would bootstrap the first admin", () => {
  const settings = loadSettings(testEnv({ ADMIN_PASSWORD: undefined, ALLOW_INSECURE_DEFAULTS: "0" }));
  assert.throws(() => assertSecureConfig(settings, { adminBootstrapNeeded: true }), /ADMIN_PASSWORD/);
  // Once an admin account exists the value is never read, so it is harmless.
  assertSecureConfig(settings, { adminBootstrapNeeded: false });
  // SESSION_SECRET is checked either way.
  const noSecret = loadSettings(testEnv({ SESSION_SECRET: undefined, ALLOW_INSECURE_DEFAULTS: "0" }));
  assert.throws(() => assertSecureConfig(noSecret, { adminBootstrapNeeded: false }), /SESSION_SECRET/);
});

test("the guard passes when all secrets are real; TEAM_PASSCODE is not required", () => {
  assertSecureConfig(
    loadSettings(
      testEnv({
        TEAM_PASSCODE: undefined,
        ADMIN_PASSWORD: "a-real-admin-password",
        SESSION_SECRET: "a-real-session-secret",
        ALLOW_INSECURE_DEFAULTS: "0",
      }),
    ),
  );
});

test("the dev flag allows defaults explicitly", () => {
  assertSecureConfig(loadSettings(testEnv({ ...DEFAULT_SECRETS, ALLOW_INSECURE_DEFAULTS: "1" })));
});

test("the app refuses to start with default secrets", () => {
  // The end-to-end claim: no session can be minted from repo defaults.
  assert.throws(
    () => buildApp({ env: testEnv({ ...DEFAULT_SECRETS, ALLOW_INSECURE_DEFAULTS: "0" }) }),
    InsecureDefaultsError,
  );
});

test("a fresh database with the default ADMIN_PASSWORD refuses to start and creates no admin", () => {
  const env = testEnv({ ADMIN_PASSWORD: undefined, ALLOW_INSECURE_DEFAULTS: "0" });
  assert.throws(() => buildApp({ env }), InsecureDefaultsError);
  assert.equal(query(env.DB_PATH, "SELECT COUNT(*) AS n FROM members WHERE role = 'admin'")[0].n, 0);
});

test("once an admin exists, a default or missing ADMIN_PASSWORD no longer blocks startup", () => {
  const env = testEnv();
  buildApp({ env }).close(); // bootstraps the admin from the real ADMIN_PASSWORD
  const again = buildApp({ env: { ...env, ADMIN_PASSWORD: "" } });
  again.close();
  delete env.ADMIN_PASSWORD;
  buildApp({ env }).close();
  assert.equal(query(env.DB_PATH, "SELECT COUNT(*) AS n FROM members WHERE role = 'admin'")[0].n, 1);
});

test("TEAM_PASSCODE still set only warns; startup continues", () => {
  const env = testEnv({ TEAM_PASSCODE: "old-team-passcode" });
  assert.equal(loadSettings(env).teamPasscodeSet, true);
  buildApp({ env }).close();
});

test("auth tunables are validated at startup", () => {
  assert.throws(() => loadSettings(testEnv({ LOCKOUT_THRESHOLD: "0" })), /LOCKOUT_THRESHOLD/);
  assert.throws(() => loadSettings(testEnv({ PASSWORD_SCRYPT_N: "1000" })), /PASSWORD_SCRYPT_N/);
  assert.throws(() => loadSettings(testEnv({ PUBLIC_ORIGIN: "ftp://x" })), /PUBLIC_ORIGIN/);
  assert.equal(loadSettings(testEnv({ PUBLIC_ORIGIN: "https://Example.com:443/" })).publicOrigin, "https://example.com");
  const defaults = loadSettings({});
  assert.deepEqual(
    [defaults.loginRateLimitAttempts, defaults.loginRateLimitWindowSeconds, defaults.lockoutThreshold,
      defaults.lockoutBaseSeconds, defaults.lockoutMaxSeconds, defaults.setupCodeTtlSeconds, defaults.passwordScryptN],
    [10, 300, 5, 900, 86400, 259200, 32768],
  );
});

test("COOKIE_SECURE defaults to true outside dev mode", () => {
  const settings = loadSettings(testEnv({ COOKIE_SECURE: undefined, ALLOW_INSECURE_DEFAULTS: undefined }));
  assert.equal(settings.cookieSecure, true);
});

test("COOKIE_SECURE defaults to false in dev mode", () => {
  // Local http dev keeps working without setting COOKIE_SECURE by hand.
  const settings = loadSettings(testEnv({ COOKIE_SECURE: undefined, ALLOW_INSECURE_DEFAULTS: "1" }));
  assert.equal(settings.cookieSecure, false);
});

test("COOKIE_SECURE can still be forced on in dev mode", () => {
  const settings = loadSettings(testEnv({ COOKIE_SECURE: "1", ALLOW_INSECURE_DEFAULTS: "1" }));
  assert.equal(settings.cookieSecure, true);
});

test("a malformed integer setting aborts startup", () => {
  assert.throws(() => loadSettings(testEnv({ MAX_UPLOAD_BYTES: "8MB" })), /MAX_UPLOAD_BYTES/);
});

const fakeRequest = (forwardedFor, extraHeaders = {}) => ({
  socket: { remoteAddress: "::ffff:10.0.0.9" },
  headers: { "x-forwarded-for": forwardedFor, ...extraHeaders },
});

test("X-Forwarded-For is ignored without a trusted proxy", () => {
  // An unfiltered XFF makes every audit IP forgeable by the client.
  const settings = loadSettings(testEnv({ TRUSTED_PROXY_IPS: undefined }));
  assert.equal(clientIp(fakeRequest("1.2.3.4"), settings), "10.0.0.9");
});

test("from a trusted proxy, the RIGHTMOST X-Forwarded-For entry wins", () => {
  // The proxy appends the address it saw; anything left of it the client sent.
  const settings = loadSettings(testEnv({ TRUSTED_PROXY_IPS: "10.0.0.9" }));
  assert.equal(clientIp(fakeRequest("1.2.3.4"), settings), "1.2.3.4");
  assert.equal(clientIp(fakeRequest("6.6.6.6, 1.2.3.4"), settings), "1.2.3.4", "spoofed leftmost entry ignored");
  assert.equal(clientIp(fakeRequest(" 6.6.6.6 ,1.2.3.4 , "), settings), "1.2.3.4");
  assert.equal(clientIp(fakeRequest(undefined), settings), "10.0.0.9");
});

test("CLIENT_IP_HEADER is honoured only from a trusted peer", () => {
  const trusted = loadSettings(testEnv({ TRUSTED_PROXY_IPS: "*", CLIENT_IP_HEADER: "Fly-Client-IP" }));
  assert.equal(trusted.clientIpHeader, "fly-client-ip");
  const request = fakeRequest("6.6.6.6, 7.7.7.7", { "fly-client-ip": "203.0.113.5" });
  assert.equal(clientIp(request, trusted), "203.0.113.5", "the header beats X-Forwarded-For");
  assert.equal(clientIp(fakeRequest("6.6.6.6"), trusted), "10.0.0.9", "header missing → peer, never XFF");

  const untrusted = loadSettings(testEnv({ TRUSTED_PROXY_IPS: undefined, CLIENT_IP_HEADER: "fly-client-ip" }));
  assert.equal(clientIp(request, untrusted), "10.0.0.9", "a client cannot set it directly");
  const otherPeer = loadSettings(testEnv({ TRUSTED_PROXY_IPS: "10.0.0.1", CLIENT_IP_HEADER: "fly-client-ip" }));
  assert.equal(clientIp(request, otherPeer), "10.0.0.9");
});

test("the Vision key travels in a header, not the URL", async () => {
  // URLs leak into logs; the API key must not ride in the query string.
  const captured = {};
  const extractor = new VisionOCRExtractor("secret-key-value", {
    fetchImpl: async (url, init) => {
      captured.url = String(url);
      captured.headers = init.headers;
      throw new Error("stop here — the request shape is all we assert");
    },
  });
  const result = await extractor.extract(Buffer.from("fake-image-bytes"));

  assert.equal(captured.url, VISION_ENDPOINT);
  assert.ok(!captured.url.includes("secret-key-value"));
  assert.ok(!captured.url.includes("key="));
  assert.equal(captured.headers["X-Goog-Api-Key"], "secret-key-value");
  // A provider outage is UNREADABLE, never a fraud signal.
  assert.equal(result.found, false);
});
