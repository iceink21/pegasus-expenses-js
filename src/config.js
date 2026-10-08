// Central configuration. Every tunable lives here — no scattered literals.
//
// All values come from environment variables so the same code runs locally
// with zero credentials and on Railway with real ones. loadSettings() takes the
// env object explicitly (process.env in production) so tests can build as many
// independent configurations as they like without mutating global state.

import { createLogger } from "./log.js";
import { parsePyFloat, parsePyInt } from "../shared/numbers.js";

const logger = createLogger("pegasus.config");

const TRUE_WORDS = new Set(["1", "true", "yes", "on"]);

function envBool(env, name, fallback = false) {
  const raw = env[name];
  if (raw === undefined) return fallback;
  return TRUE_WORDS.has(raw.trim().toLowerCase());
}

function envFloat(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = parsePyFloat(raw);
  return value === null ? fallback : value;
}

// Python's int() raises on a malformed value, which aborts startup; so does this.
function envInt(env, name, fallback) {
  const raw = env[name] ?? String(fallback);
  const value = parsePyInt(raw);
  if (value === null) throw new Error(name + " must be an integer, got " + JSON.stringify(raw));
  return value;
}

function envList(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return [...fallback];
  return raw.split(",").map((part) => part.trim()).filter(Boolean);
}

// --- published insecure defaults -------------------------------------------
// These literals are committed to the repo, so anyone reading it can mint a
// session. They exist ONLY so `npm test` and a first `git clone` run without
// ceremony. The startup guard (assertSecureConfig) refuses to serve with any
// of them still in place unless ALLOW_INSECURE_DEFAULTS=1.
//
// The settings defaults below and the guard BOTH reference these constants, so
// the two can never drift apart.
export const DEFAULT_TEAM_PASSCODE = "pegasus";
export const DEFAULT_ADMIN_PASSWORD = "admin";
export const DEFAULT_SESSION_SECRET = "dev-insecure-secret-change-me";

// [settings key, env var, published default]
export const INSECURE_DEFAULTS = Object.freeze([
  ["teamPasscode", "TEAM_PASSCODE", DEFAULT_TEAM_PASSCODE],
  ["adminPassword", "ADMIN_PASSWORD", DEFAULT_ADMIN_PASSWORD],
  ["sessionSecret", "SESSION_SECRET", DEFAULT_SESSION_SECRET],
]);

export const DEFAULT_MEMBERS = Object.freeze(["ติ้ว", "นาย", "คูการ์", "หัวหน้าทีม"]);

export const DEFAULT_CATEGORIES = Object.freeze([
  "อะไหล่โดรน",
  "อิเล็กทรอนิกส์",
  "วัสดุสิ้นเปลือง",
  "เครื่องมือ",
  "เดินทาง",
  "ค่าสมัคร/ค่าธรรมเนียม",
  "อื่น ๆ",
]);

export function loadSettings(env = process.env) {
  const allowInsecureDefaults = envBool(env, "ALLOW_INSECURE_DEFAULTS", false);
  const matchEpsilonThb = envFloat(env, "MATCH_EPSILON_THB", 1.0);
  const matchEpsilonPct = envFloat(env, "MATCH_EPSILON_PCT", 0.005);

  return Object.freeze({
    // MUST point at a Railway Volume mount in production. The plain Railway
    // filesystem is ephemeral and is wiped on every redeploy.
    dbPath: env.DB_PATH ?? "./data/pegasus.db",
    localUploadDir: env.LOCAL_UPLOAD_DIR ?? "./data/uploads",

    teamPasscode: env.TEAM_PASSCODE ?? DEFAULT_TEAM_PASSCODE,
    adminPassword: env.ADMIN_PASSWORD ?? DEFAULT_ADMIN_PASSWORD,
    sessionSecret: env.SESSION_SECRET ?? DEFAULT_SESSION_SECRET,
    sessionMaxAgeSeconds: envInt(env, "SESSION_MAX_AGE_SECONDS", 60 * 60 * 12),
    // Explicit dev opt-in. OFF by default: a plain `npm start` with no
    // environment REFUSES to start while the published defaults are in place.
    allowInsecureDefaults,
    // Secure by default. Only a declared dev environment may serve the session
    // cookie over plain http, which is what keeps local http dev working.
    cookieSecure: envBool(env, "COOKIE_SECURE", !allowInsecureDefaults),

    members: envList(env, "TEAM_MEMBERS", DEFAULT_MEMBERS),
    categories: envList(env, "EXPENSE_CATEGORIES", DEFAULT_CATEGORIES),

    // MATCH when |claimed - extracted| <= max(epsilon_thb, claimed * epsilon_pct).
    // Single source of truth; never re-hardcode a tolerance anywhere else.
    matchEpsilonThb,
    matchEpsilonPct,

    googleVisionApiKey: env.GOOGLE_VISION_API_KEY || null,
    gdriveSaJson: env.GDRIVE_SA_JSON || null,
    gdriveFolderId: env.GDRIVE_FOLDER_ID || null,
    // When set, startup FAILS LOUDLY instead of silently falling back to stubs.
    requireRealProviders: envBool(env, "REQUIRE_REAL_PROVIDERS", false),
    enableQrStage: envBool(env, "ENABLE_QR_STAGE", true),

    // Peer addresses whose X-Forwarded-For header may be believed. Empty (the
    // default) means NEVER believe it — an unfiltered XFF lets any client forge
    // the IP in every audit row. Set to the platform edge address, or to "*"
    // when the PaaS assigns the proxy a dynamic address (Railway) AND nothing
    // but that proxy can reach the port.
    trustedProxyIps: envList(env, "TRUSTED_PROXY_IPS", []),

    maxUploadBytes: envInt(env, "MAX_UPLOAD_BYTES", 8 * 1024 * 1024),

    /** Absolute THB tolerance allowed for this claim size. */
    toleranceFor(claimed) {
      return Math.max(matchEpsilonThb, Math.abs(claimed) * matchEpsilonPct);
    },
  });
}

/**
 * Raised at startup when repo-published default secrets are still in use.
 *
 * Deliberately a startup-time check and NOT part of loadSettings(): building a
 * settings object must stay free (tests build one constantly), but the app must
 * not be able to SERVE with defaults. Same split as ProviderConfigError in
 * providers.js.
 */
export class InsecureDefaultsError extends Error {
  constructor(message) {
    super(message);
    this.name = "InsecureDefaultsError";
  }
}

/**
 * Refuse to boot while any published default secret is still in place.
 *
 * Bypass for local development with ALLOW_INSECURE_DEFAULTS=1 — an explicit,
 * off-by-default opt-in, so forgetting to configure production fails loudly
 * instead of shipping a passcode that is printed in the repo.
 */
export function assertSecureConfig(settings) {
  const offenders = INSECURE_DEFAULTS.filter(
    ([key, , defaultValue]) => settings[key] === defaultValue,
  );
  if (offenders.length === 0) return;

  if (settings.allowInsecureDefaults) {
    logger.warning(
      "ALLOW_INSECURE_DEFAULTS=1 — serving with published default secrets (" +
        offenders.map(([, envVar]) => envVar).join(", ") +
        "). Local development only; these are public in the repo.",
    );
    return;
  }

  const lines = [
    "Refusing to start: these secrets are still at their repo-published " +
      "default value, so anyone who can read the source can log in as admin.",
    "",
    ...offenders.map(([key, envVar]) => "  - " + envVar + " (settings." + key + ")"),
    "",
    "Fix by setting each of those env vars to a real secret, e.g.:",
    "  export SESSION_SECRET=\"$(node -e " +
      "\"console.log(require('node:crypto').randomBytes(32).toString('base64url'))\")\"",
    "",
    "For local development only, bypass with ALLOW_INSECURE_DEFAULTS=1 " +
      "(never set this in production).",
  ];
  const message = lines.join("\n");
  logger.error(message);
  throw new InsecureDefaultsError(message);
}
