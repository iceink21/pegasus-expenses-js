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
  DEFAULT_TEAM_PASSCODE,
  InsecureDefaultsError,
  loadSettings,
} from "../src/config.js";
import { VISION_ENDPOINT, VisionOCRExtractor } from "../src/extraction/vision.js";
import { testEnv } from "./helpers.js";

const DEFAULT_SECRETS = { TEAM_PASSCODE: undefined, ADMIN_PASSWORD: undefined, SESSION_SECRET: undefined };

test("settings can still be built with the defaults", () => {
  // Building settings is free — only SERVING is gated.
  const settings = loadSettings({});
  assert.equal(settings.teamPasscode, DEFAULT_TEAM_PASSCODE);
  assert.equal(settings.adminPassword, DEFAULT_ADMIN_PASSWORD);
  assert.equal(settings.sessionSecret, DEFAULT_SESSION_SECRET);
});

test("the guard rejects every published default", () => {
  const settings = loadSettings(testEnv({ ...DEFAULT_SECRETS, ALLOW_INSECURE_DEFAULTS: "0" }));
  assert.throws(
    () => assertSecureConfig(settings),
    (error) => {
      assert.ok(error instanceof InsecureDefaultsError);
      // The error must name WHICH vars are wrong, not just "insecure config".
      for (const name of ["TEAM_PASSCODE", "ADMIN_PASSWORD", "SESSION_SECRET", "ALLOW_INSECURE_DEFAULTS"]) {
        assert.ok(error.message.includes(name), name);
      }
      return true;
    },
  );
});

test("the guard names only the offending variable", () => {
  const settings = loadSettings(
    testEnv({
      TEAM_PASSCODE: "a-real-passcode",
      ADMIN_PASSWORD: "a-real-admin-password",
      SESSION_SECRET: undefined, // only this one left at its default
      ALLOW_INSECURE_DEFAULTS: "0",
    }),
  );
  assert.throws(
    () => assertSecureConfig(settings),
    (error) =>
      error.message.includes("SESSION_SECRET") &&
      !error.message.includes("TEAM_PASSCODE") &&
      !error.message.includes("ADMIN_PASSWORD"),
  );
});

test("the guard passes when all secrets are real", () => {
  assertSecureConfig(
    loadSettings(
      testEnv({
        TEAM_PASSCODE: "a-real-passcode",
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

const fakeRequest = (forwardedFor) => ({
  socket: { remoteAddress: "::ffff:10.0.0.9" },
  headers: { "x-forwarded-for": forwardedFor },
});

test("X-Forwarded-For is ignored without a trusted proxy", () => {
  // An unfiltered XFF makes every audit IP forgeable by the client.
  const settings = loadSettings(testEnv({ TRUSTED_PROXY_IPS: undefined }));
  assert.equal(clientIp(fakeRequest("1.2.3.4"), settings), "10.0.0.9");
});

test("X-Forwarded-For is honoured from a trusted proxy", () => {
  const settings = loadSettings(testEnv({ TRUSTED_PROXY_IPS: "10.0.0.9" }));
  assert.equal(clientIp(fakeRequest("1.2.3.4, 10.0.0.9"), settings), "1.2.3.4");
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
