// Application factory: config guard → database → providers → routes.
//
// The order is the Python lifespan's: the secret guard runs before anything
// touches the database, and provider selection can still abort startup
// (REQUIRE_REAL_PROVIDERS=1). buildApp() throws instead of returning an app
// that should not serve.

import { fileURLToPath } from "node:url";

import express from "express";

import { assertSecureConfig, loadSettings } from "./config.js";
import { openDb } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import { createLogger } from "./log.js";
import { buildProviders } from "./providers.js";
import { createAdminRouter } from "./routes/admin.js";
import { createAuthRouter } from "./routes/auth-routes.js";
import { errorHandler, notFound } from "./routes/errors.js";
import { createExpensesRouter } from "./routes/expenses.js";

const logger = createLogger("pegasus");
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const SHARED_DIR = fileURLToPath(new URL("../shared/", import.meta.url));

export function buildApp({ env = process.env, fetchImpl = fetch } = {}) {
  const settings = loadSettings(env);
  // Throws InsecureDefaultsError while a repo-published default secret is in
  // place and ALLOW_INSECURE_DEFAULTS is not set — before the database opens.
  assertSecureConfig(settings);

  const db = openDb(settings.dbPath);
  try {
    // Idempotent; links pre-existing expenses to the members table.
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  logger.info("database ready at " + settings.dbPath);

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

  const ctx = Object.freeze({ settings, db, providers });
  const app = express();
  app.disable("x-powered-by");

  app.use(express.static(PUBLIC_DIR, { index: false }));
  // Browser-safe modules used by both the server and the page scripts.
  app.use("/shared", express.static(SHARED_DIR, { index: false }));
  app.get("/healthz", (req, res) => res.json({ status: "ok", providers: providers.describe() }));
  app.get("/favicon.ico", (req, res) => res.status(204).end());

  app.use(createAuthRouter(ctx));
  app.use(createExpensesRouter(ctx));
  app.use(createAdminRouter(ctx));

  app.use(notFound);
  app.use(errorHandler);

  return { app, ctx, close: () => db.close() };
}
