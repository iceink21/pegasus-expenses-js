// Central configuration. Every tunable lives here — no scattered literals.
//
// All values come from environment variables so the same code runs locally
// with zero credentials and on Railway with real ones. loadSettings() takes the
// env object explicitly (process.env in production) so tests can build as many
// independent configurations as they like without mutating global state.

import { createLogger } from "./log.js";
import { DEFAULT_SCRYPT_N } from "./passwords.js";
import { parsePyFloat, parsePyInt } from "../shared/numbers.js";
import {
  DEFAULT_MAX_AMOUNT_THB,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_OPENROUTER_MODEL,
} from "./extraction/llm.js";

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

function envPositiveInt(env, name, fallback) {
  const value = envInt(env, name, fallback);
  if (value < 1) throw new Error(name + " must be a positive integer, got " + value);
  return value;
}

// scrypt needs a power of two above 1.
function envScryptN(env, name, fallback) {
  const value = envInt(env, name, fallback);
  if (value < 2 || (value & (value - 1)) !== 0) {
    throw new Error(name + " must be a power of two, got " + value);
  }
  return value;
}

// "https://Host:443/" → "https://host". Anything but an http(s) origin aborts startup.
function normalizeOrigin(raw, name) {
  if (raw === undefined || raw.trim() === "") return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(name + " must be an origin like https://example.com, got " + JSON.stringify(raw));
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(name + " must use http or https, got " + JSON.stringify(raw));
  }
  return url.origin;
}

function envList(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return [...fallback];
  return raw.split(",").map((part) => part.trim()).filter(Boolean);
}

// --- published insecure defaults -------------------------------------------
// These literals are committed to the repo, so anyone reading it can mint a
// session (SESSION_SECRET) or log in as the first admin (ADMIN_PASSWORD). They
// exist ONLY so `npm test` and a first `git clone` run without ceremony. The
// startup guard (assertSecureConfig) refuses to serve with them in place
// unless ALLOW_INSECURE_DEFAULTS=1.
//
// The settings defaults below and the guard BOTH reference these constants, so
// the two can never drift apart.
export const DEFAULT_ADMIN_PASSWORD = "admin";
export const DEFAULT_SESSION_SECRET = "dev-insecure-secret-change-me";

// [settings key, env var, published default, needed only for admin bootstrap]
// ADMIN_PASSWORD is read once, to create the first admin account when none
// exists; after that it is ignored, so its default is only dangerous then.
export const INSECURE_DEFAULTS = Object.freeze([
  ["adminPassword", "ADMIN_PASSWORD", DEFAULT_ADMIN_PASSWORD, true],
  ["sessionSecret", "SESSION_SECRET", DEFAULT_SESSION_SECRET, false],
]);

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

    // Retired: per-member accounts replaced the shared team passcode. Only
    // whether it is still set is kept, to warn at startup.
    teamPasscodeSet: env.TEAM_PASSCODE !== undefined && env.TEAM_PASSCODE !== "",
    // Bootstrap-only: hashed into the first admin account when no admin exists.
    adminPassword: env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD,
    adminPasswordSet: env.ADMIN_PASSWORD !== undefined && env.ADMIN_PASSWORD !== "",
    sessionSecret: env.SESSION_SECRET ?? DEFAULT_SESSION_SECRET,
    sessionMaxAgeSeconds: envInt(env, "SESSION_MAX_AGE_SECONDS", 60 * 60 * 12),
    // Explicit dev opt-in. OFF by default: a plain `npm start` with no
    // environment REFUSES to start while the published defaults are in place.
    allowInsecureDefaults,
    // Secure by default. Only a declared dev environment may serve the session
    // cookie over plain http, which is what keeps local http dev working.
    cookieSecure: envBool(env, "COOKIE_SECURE", !allowInsecureDefaults),

    // Optional exact origin ("https://pegasus.example") for the CSRF check.
    // Unset: the request's own Host header is the expected origin.
    publicOrigin: normalizeOrigin(env.PUBLIC_ORIGIN, "PUBLIC_ORIGIN"),

    // --- login protection (defaults are the production values) -------------
    // Per-IP token bucket on POST /login.
    loginRateLimitAttempts: envPositiveInt(env, "LOGIN_RATE_LIMIT_ATTEMPTS", 10),
    loginRateLimitWindowSeconds: envPositiveInt(env, "LOGIN_RATE_LIMIT_WINDOW_SECONDS", 5 * 60),
    // Per-account lockout: this many consecutive failures lock the account for
    // the base duration, doubling with each further lockout up to the cap.
    lockoutThreshold: envPositiveInt(env, "LOCKOUT_THRESHOLD", 5),
    lockoutBaseSeconds: envPositiveInt(env, "LOCKOUT_BASE_SECONDS", 15 * 60),
    lockoutMaxSeconds: envPositiveInt(env, "LOCKOUT_MAX_SECONDS", 24 * 60 * 60),
    setupCodeTtlSeconds: envPositiveInt(env, "SETUP_CODE_TTL_SECONDS", 72 * 60 * 60),
    // scrypt cost. Lower it ONLY in tests; a weaker hash protects nothing.
    passwordScryptN: envScryptN(env, "PASSWORD_SCRYPT_N", DEFAULT_SCRYPT_N),

    // Members are accounts in the members table, created by an admin; there is
    // no configured roster (TEAM_MEMBERS is no longer read).
    categories: envList(env, "EXPENSE_CATEGORIES", DEFAULT_CATEGORIES),

    // MATCH when |claimed - extracted| <= max(epsilon_thb, claimed * epsilon_pct).
    // Single source of truth; never re-hardcode a tolerance anywhere else.
    matchEpsilonThb,
    matchEpsilonPct,

    googleVisionApiKey: env.GOOGLE_VISION_API_KEY || null,
    // OpenRouter vision LLM: primary amount source when Vision is absent,
    // fallback after Vision otherwise. Unset = stage off.
    openrouterApiKey: env.OPENROUTER_API_KEY || null,
    openrouterModel: (env.OPENROUTER_MODEL || "").trim() || DEFAULT_OPENROUTER_MODEL,
    llmMinConfidence: envFloat(env, "LLM_MIN_CONFIDENCE", DEFAULT_MIN_CONFIDENCE),
    llmMaxAmountThb: envFloat(env, "LLM_MAX_AMOUNT_THB", DEFAULT_MAX_AMOUNT_THB),
    gdriveSaJson: env.GDRIVE_SA_JSON || null,
    gdriveFolderId: env.GDRIVE_FOLDER_ID || null,
    // Optional existing folder ids for the routed evidence folders. Unset =
    // find-or-create "Verified" / "Needs-Review" / "Rejected" under
    // GDRIVE_FOLDER_ID on first use.
    gdriveFolderVerified: env.GDRIVE_FOLDER_VERIFIED || null,
    gdriveFolderReview: env.GDRIVE_FOLDER_REVIEW || null,
    gdriveFolderRejected: env.GDRIVE_FOLDER_REJECTED || null,
    // When set, startup FAILS LOUDLY instead of silently falling back to stubs.
    requireRealProviders: envBool(env, "REQUIRE_REAL_PROVIDERS", false),
    enableQrStage: envBool(env, "ENABLE_QR_STAGE", true),

    // Peer addresses whose X-Forwarded-For header may be believed. Empty (the
    // default) means NEVER believe it — an unfiltered XFF lets any client forge
    // the IP in every audit row. Set to the platform edge address, or to "*"
    // when the PaaS assigns the proxy a dynamic address (Railway) AND nothing
    // but that proxy can reach the port.
    trustedProxyIps: envList(env, "TRUSTED_PROXY_IPS", []),
    // Header the trusted proxy sets to the real client address (Fly:
    // "fly-client-ip"). Read only from a trusted peer. Unset = the rightmost
    // X-Forwarded-For entry. Lower-cased: Node lower-cases header names.
    clientIpHeader: (env.CLIENT_IP_HEADER ?? "").trim().toLowerCase() || null,

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
 * Refuse to boot while a published default secret would actually be used.
 *
 * SESSION_SECRET is always checked. ADMIN_PASSWORD only matters while the
 * database has no admin account yet (it becomes that account's first password,
 * which must be changed at first login); pass `adminBootstrapNeeded: false`
 * once an admin exists. The default is true so a bare call stays strict.
 *
 * Bypass for local development with ALLOW_INSECURE_DEFAULTS=1 — an explicit,
 * off-by-default opt-in, so forgetting to configure production fails loudly
 * instead of shipping a secret that is printed in the repo.
 */
export function assertSecureConfig(settings, { adminBootstrapNeeded = true } = {}) {
  const offenders = INSECURE_DEFAULTS.filter(
    ([key, , defaultValue, bootstrapOnly]) =>
      settings[key] === defaultValue && (!bootstrapOnly || adminBootstrapNeeded),
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
      "default value, so anyone who can read the source could use them.",
    "",
    ...offenders.map(([key, envVar, , bootstrapOnly]) =>
      "  - " + envVar + " (settings." + key + ")" +
        (bootstrapOnly ? " — no admin account exists yet, so it would become the first admin's password" : ""),
    ),
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
