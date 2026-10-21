#!/usr/bin/env node
// Recovery: issue a fresh one-time setup code for an account, from a shell on
// the server (e.g. `fly ssh console`), when no admin can log in to do it.
//
//   npm run admin:reset -- <username>
//   npm run admin:reset -- <username> --promote   (also make the account an admin)
//
// Prints the setup code ONCE on stdout — that is its whole purpose — and
// writes an audit row WITHOUT the code. The reset clears the password, unlocks
// the account, enables it if it was disabled, and ends all of its sessions.
// It reads DB_PATH (and PASSWORD_SCRYPT_N, SETUP_CODE_TTL_SECONDS) from the
// same environment as the app; run it where the app's database lives.

import { issueSetupCode, findAccountByUsername, normalizeUsername, setAccountDisabled, setAccountRole } from "../src/accounts.js";
import { loadSettings } from "../src/config.js";
import { openDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { createPasswordHasher } from "../src/passwords.js";

const CLI_ACTOR = Object.freeze({ kind: "system", name: "cli:admin-reset", clientIp: "", memberId: null });

function usage(message) {
  if (message) process.stderr.write(message + "\n");
  process.stderr.write("usage: npm run admin:reset -- <username> [--promote]\n");
  process.exit(2);
}

async function main(argv) {
  const flags = argv.filter((arg) => arg.startsWith("--"));
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const unknown = flags.filter((flag) => flag !== "--promote");
  if (unknown.length > 0) usage("unknown option " + unknown[0]);
  if (positional.length !== 1) usage();

  const settings = loadSettings(process.env);
  const db = openDb(settings.dbPath);
  try {
    migrate(db);
    const account = findAccountByUsername(db, normalizeUsername(positional[0]));
    if (!account) {
      process.stderr.write("no account with username " + JSON.stringify(positional[0]) + " in " + settings.dbPath + "\n");
      process.exitCode = 1;
      return;
    }
    if (account.disabled) setAccountDisabled(db, account.id, false, CLI_ACTOR);
    if (flags.includes("--promote")) setAccountRole(db, account.id, "admin", CLI_ACTOR);
    const passwords = createPasswordHasher({ scryptN: settings.passwordScryptN });
    const { setupCode, expiresAt } = await issueSetupCode(db, passwords, settings, account.id, CLI_ACTOR, {
      source: "cli",
    });
    process.stdout.write(
      "Setup code for " + account.username + " (" + account.name + "): " + setupCode + "\n" +
        "Valid until " + expiresAt + " (UTC), single use. Log in at /login with the username and this code,\n" +
        "then choose a new password. It is not stored anywhere in readable form and will not be shown again.\n",
    );
  } finally {
    db.close();
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write("admin-reset failed: " + (error?.detail ?? error?.message ?? String(error)) + "\n");
  process.exit(1);
});
