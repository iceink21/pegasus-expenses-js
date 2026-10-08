// Port of tests/test_providers.py — provider selection must be explicit, never
// a silent fallback in production.

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildApp } from "../src/app.js";
import { loadSettings } from "../src/config.js";
import { buildProviders, ProviderConfigError } from "../src/providers.js";
import { NullSlipVerifier } from "../src/slipverify/null.js";
import { VerificationStatus } from "../src/slipverify/base.js";
import { loadServiceAccountInfo } from "../src/storage/gdrive.js";
import { startApp, testEnv } from "./helpers.js";

test("stubs are selected when credentials are absent", () => {
  const providers = buildProviders(loadSettings(testEnv()));
  assert.equal(providers.usingStubOcr, true);
  assert.equal(providers.usingStubStorage, true);
  assert.equal(providers.ocrStage.name, "StubOCRExtractor");
  assert.equal(providers.storage.name, "LocalDiskStorage");
  assert.equal(providers.slipVerifier.name, "NullSlipVerifier");
  const joined = providers.startupNotes.join(" ");
  assert.ok(joined.includes("GOOGLE_VISION_API_KEY absent"));
  assert.ok(joined.includes("GDRIVE_SA_JSON absent"));
});

test("REQUIRE_REAL_PROVIDERS fails provider selection", () => {
  const settings = loadSettings(testEnv({ REQUIRE_REAL_PROVIDERS: "1" }));
  assert.throws(
    () => buildProviders(settings),
    (error) => error instanceof ProviderConfigError && error.message.includes("GOOGLE_VISION_API_KEY"),
  );
});

test("app startup fails when real providers are required", () => {
  assert.throws(
    () => buildApp({ env: testEnv({ REQUIRE_REAL_PROVIDERS: "1" }) }),
    ProviderConfigError,
  );
});

test("Vision is selected when the key is present", () => {
  const providers = buildProviders(
    loadSettings(testEnv({ GOOGLE_VISION_API_KEY: "fake-key-not-called" })),
  );
  assert.equal(providers.usingStubOcr, false);
  assert.equal(providers.ocrStage.name, "VisionOCRExtractor");
});

test("broken Drive credentials fall back loudly, or abort when real providers are required", () => {
  const broken = { GDRIVE_SA_JSON: "not json at all", GDRIVE_FOLDER_ID: "folder" };
  const providers = buildProviders(loadSettings(testEnv(broken)));
  assert.equal(providers.storage.name, "LocalDiskStorage");
  assert.ok(providers.startupNotes.some((note) => note.startsWith("GoogleDriveStorage init failed")));

  const strict = loadSettings(
    testEnv({ ...broken, REQUIRE_REAL_PROVIDERS: "1", GOOGLE_VISION_API_KEY: "k" }),
  );
  assert.throws(() => buildProviders(strict), /Drive credentials failed/);
});

test("/healthz reports provider selection", async (t) => {
  const app = await startApp(t);
  const response = await app.client().get("/healthz");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.providers.using_stub_ocr, true);
  assert.equal(body.providers.slip_verifier, "NullSlipVerifier");
});

test("null slip verifier is a no-op", async () => {
  const verification = await new NullSlipVerifier().verify({
    imageBytes: Buffer.from("x"),
    claimedAmount: 10.0,
  });
  assert.equal(verification.status, VerificationStatus.NOT_ATTEMPTED);
  assert.equal(verification.attempted, false);
});

test("Drive accepts raw and base64 service-account JSON", () => {
  const info = { client_email: "svc@example.iam.gserviceaccount.com", private_key: "x" };
  const raw = JSON.stringify(info);
  assert.equal(loadServiceAccountInfo(raw).client_email, info.client_email);
  const encoded = Buffer.from(raw, "utf8").toString("base64");
  assert.equal(loadServiceAccountInfo(encoded).client_email, info.client_email);

  assert.throws(() => loadServiceAccountInfo(""));
  assert.throws(() => loadServiceAccountInfo("@@not-base64@@"), /neither JSON nor base64/);
  assert.throws(() => loadServiceAccountInfo("{\"no_email\": 1}"), /service-account key/);
});
