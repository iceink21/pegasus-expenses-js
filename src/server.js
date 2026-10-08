// Process entrypoint: build the app from process.env and listen.
//
// PORT defaults to 8811 (8000 is taken by Apache on the dev Mac). HOST
// defaults to 0.0.0.0 so Railway's proxy can reach the container;
// scripts/run_local.sh binds 127.0.0.1 for local development.

import { buildApp } from "./app.js";
import { createLogger } from "./log.js";

const logger = createLogger("pegasus");

let built;
try {
  built = buildApp({ env: process.env });
} catch (error) {
  // InsecureDefaultsError / ProviderConfigError already logged their full
  // explanation where they were raised; anything else has not.
  const explained = ["InsecureDefaultsError", "ProviderConfigError"].includes(error.name);
  logger.error("startup aborted: " + (explained ? error.name : error.stack));
  process.exit(1);
}

const port = Number(process.env.PORT || 8811);
const host = process.env.HOST || "0.0.0.0";
const server = built.app.listen(port, host, () => {
  logger.info("listening on http://" + host + ":" + port);
});

function shutdown(signal) {
  logger.info(signal + " received, closing");
  server.close(() => {
    built.close();
    process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
