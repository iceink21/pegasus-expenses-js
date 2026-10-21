// Application factory: database → config guard → admin bootstrap → providers
// → routes.
//
// The secret guard needs to know whether an admin account exists (ADMIN_PASSWORD
// is only used, and so only dangerous at its default, while none does), so it
// runs right after the migration and before anything can serve. Provider
// selection can still abort startup (REQUIRE_REAL_PROVIDERS=1). buildApp()
// throws instead of returning an app that should not serve.

import { fileURLToPath } from "node:url";

import express from "express";

import { adminExists, bootstrapAdmin } from "./accounts.js";
import { assertSecureConfig, loadSettings } from "./config.js";
import { csrfGuard } from "./csrf.js";
import { openDb } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import { createLogger } from "./log.js";
import { createPasswordHasher, DEFAULT_SCRYPT_N } from "./passwords.js";
import { buildProviders } from "./providers.js";
import { TokenBucketLimiter } from "./ratelimit.js";
import { createAdminMembersRouter } from "./routes/admin-members.js";
import { createAdminRouter } from "./routes/admin.js";
import { createAuthRouter } from "./routes/auth-routes.js";
import { errorHandler, notFound } from "./routes/errors.js";
import { createExpensesRouter } from "./routes/expenses.js";

const logger = createLogger("pegasus");
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const SHARED_DIR = fileURLToPath(new URL("../shared/", import.meta.url));

export function buildApp({ env = process.env, fetchImpl = fetch } = {}) {
  const settings = loadSettings(env);
  const passwords = createPasswordHasher({ scryptN: settings.passwordScryptN });

  const db = openDb(settings.dbPath);
  try {
    // Idempotent; links pre-existing expenses to members and adds the account
    // columns (existing members get a placeholder username and no password).
    migrate(db);
    // Throws InsecureDefaultsError while a repo-published default secret would
    // be used and ALLOW_INSECURE_DEFAULTS is not set — before anything serves.
    assertSecureConfig(settings, { adminBootstrapNeeded: !adminExists(db) });
    // First start only: the admin account, from ADMIN_PASSWORD.
    bootstrapAdmin(db, passwords, settings);
  } catch (error) {
    db.close();
    throw error;
  }
  logger.info("database ready at " + settings.dbPath);
  if (settings.teamPasscodeSet) {
    logger.warning("TEAM_PASSCODE is set but no longer used (per-member accounts replaced it); unset it.");
  }
  if (settings.passwordScryptN < DEFAULT_SCRYPT_N) {
    logger.warning("PASSWORD_SCRYPT_N is below the default " + DEFAULT_SCRYPT_N + " — tests only, never production.");
  }

  let providers;
  try {
    // Throws ProviderConfigError when REQUIRE_REAL_PROVIDERS=1 and creds are
    // missing — startup fails loudly instead of serving stubs in production.
    providers = buildProviders(settings, { fetchImpl });
  } catch (error) {
    db.close();
    throw error;
  }
  logger.info("provider summary: " + JSON.stringify(providers.describe()));
  if (providers.usingStubOcr || providers.usingStubStorage) {
    logger.warning(
      "RUNNING WITH STUB PROVIDERS — do not treat verdicts as real. " +
        "Set REQUIRE_REAL_PROVIDERS=1 in production.",
    );
  }

  const loginLimiter = new TokenBucketLimiter({
    capacity: settings.loginRateLimitAttempts,
    windowSeconds: settings.loginRateLimitWindowSeconds,
  });
  const ctx = Object.freeze({ settings, db, providers, passwords, loginLimiter });
  const app = express();
  app.disable("x-powered-by");

  app.use(express.static(PUBLIC_DIR, { index: false }));
  // Browser-safe modules used by both the server and the page scripts.
  app.use("/shared", express.static(SHARED_DIR, { index: false }));
  app.get("/healthz", (req, res) => res.json({ status: "ok", providers: providers.describe() }));
  app.get("/favicon.ico", (req, res) => res.status(204).end());

  // Every POST/PUT/PATCH/DELETE below must come from this app's own pages.
  app.use(csrfGuard(ctx));
  app.use(createAuthRouter(ctx));
  app.use(createExpensesRouter(ctx));
  app.use(createAdminRouter(ctx));
  app.use(createAdminMembersRouter(ctx));

  app.use(notFound);
  app.use(errorHandler);

  return { app, ctx, close: () => db.close() };
}
