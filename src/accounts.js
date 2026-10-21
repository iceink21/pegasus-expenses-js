// Per-member login accounts: usernames, credentials, lockout, roles.
//
// Every account is a row in `members` (the admin too), so expenses, totals and
// the Excel export treat everyone alike. An account accepts at most one
// credential at a time:
//   - a password (password_hash), or
//   - a one-time setup code (setup_code_hash, until setup_code_expires_at),
//     issued by an admin; logging in with it yields a session that can only
//     set a new password (must_change_password = 1).
// A member with neither cannot log in ("needs setup").
//
// Revocation is by session_version: every session token carries the version
// it was issued under, and anything that should end existing sessions
// (password change, reset, disable, role change, logout) bumps it.
//
// Secrets never reach the audit log: rows name the account and the reason,
// never a password or a setup code.

import { AuditAction, utcNowIso, writeAudit } from "./audit.js";
import { inTransaction, statement } from "./db/connection.js";
import {
  COUNT_ACTIVE_ADMINS,
  COUNT_ADMINS,
  INSERT_ACCOUNT,
  SELECT_ACCOUNT_BY_ID,
  SELECT_ACCOUNT_BY_USERNAME,
  SELECT_ACCOUNTS,
  SELECT_MEMBER_BY_KEY,
  UPDATE_ACCOUNT_BUMP_SESSION,
  UPDATE_ACCOUNT_DISABLED,
  UPDATE_ACCOUNT_LOGIN_FAILURE,
  UPDATE_ACCOUNT_LOGIN_SUCCESS,
  UPDATE_ACCOUNT_NAME,
  UPDATE_ACCOUNT_PASSWORD,
  UPDATE_ACCOUNT_ROLE,
  UPDATE_ACCOUNT_SETUP_CODE,
  UPDATE_ACCOUNT_UNLOCK,
  UPDATE_ACCOUNT_USERNAME,
} from "./db/sql.js";
import { HttpError } from "./http-error.js";
import { createLogger } from "./log.js";
import { memberNameKey, parseMemberName } from "./members.js";
import { checkPasswordPolicy, generateSetupCode, normalizeSetupCode, PASSWORD_MAX_CHARS } from "./passwords.js";

const logger = createLogger("pegasus.accounts");

export const Role = Object.freeze({ MEMBER: "member", ADMIN: "admin" });
const ROLES = new Set(Object.values(Role));

const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
export const BOOTSTRAP_USERNAME = "admin";
const BOOTSTRAP_NAMES = ["admin", "ผู้ดูแลระบบ"];
// Anything longer cannot be a valid password or setup code; it is refused
// without being hashed (but after the same amount of work, see verifyCredential).
const MAX_SECRET_CHARS = PASSWORD_MAX_CHARS * 4;

/** Trimmed, lower-cased form of a typed username. Does not validate. */
export function normalizeUsername(raw) {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

export function isValidUsername(username) {
  return USERNAME_PATTERN.test(username);
}

/** Normalize + validate. Throws HttpError(400, "username_invalid"). */
export function parseUsername(raw) {
  const username = normalizeUsername(raw);
  if (!isValidUsername(username)) throw new HttpError(400, "username_invalid");
  return username;
}

export function parseRole(raw) {
  if (!ROLES.has(raw)) throw new HttpError(400, "invalid_role");
  return raw;
}

/** utcNowIso()'s format for an arbitrary epoch-milliseconds instant. */
export function isoAt(ms) {
  return new Date(ms).toISOString().slice(0, 19) + "+00:00";
}

function toAccount(row) {
  if (!row) return null;
  return Object.freeze({
    id: Number(row.id),
    name: String(row.name),
    username: row.username === null ? null : String(row.username),
    role: String(row.role),
    passwordHash: row.password_hash ?? null,
    mustChangePassword: Number(row.must_change_password) === 1,
    sessionVersion: Number(row.session_version),
    failedLogins: Number(row.failed_logins),
    lockedUntil: row.locked_until ?? null,
    lockoutCount: Number(row.lockout_count),
    disabled: Number(row.disabled) === 1,
    passwordChangedAt: row.password_changed_at ?? null,
    setupCodeHash: row.setup_code_hash ?? null,
    setupCodeExpiresAt: row.setup_code_expires_at ?? null,
    createdAt: row.created_at,
  });
}

export function loadAccount(db, id) {
  return Number.isSafeInteger(id) ? toAccount(statement(db, SELECT_ACCOUNT_BY_ID).get(id)) : null;
}

export function findAccountByUsername(db, username) {
  return toAccount(statement(db, SELECT_ACCOUNT_BY_USERNAME).get(username));
}

export function isLocked(account, now = Date.now()) {
  return account.lockedUntil !== null && Date.parse(account.lockedUntil) > now;
}

export function countActiveAdmins(db) {
  return Number(statement(db, COUNT_ACTIVE_ADMINS).get().n);
}

/** The credential this account accepts right now, or why there is none. */
export function activeCredential(account, now = Date.now()) {
  if (account.passwordHash) return { kind: "password", hash: account.passwordHash };
  if (account.setupCodeHash) {
    if (account.setupCodeExpiresAt && Date.parse(account.setupCodeExpiresAt) > now) {
      return { kind: "setup_code", hash: account.setupCodeHash };
    }
    return { kind: null, cause: "setup_code_expired" };
  }
  return { kind: null, cause: "no_credential" };
}

/**
 * Check `secret` against the account's active credential. Always costs one
 * scrypt verification, whether or not a credential exists, so timing does not
 * tell an expired code or a credential-less account from a wrong password.
 * Returns { ok, cause, kind, hash } — `hash` is what was verified, so the
 * caller can confirm it was not replaced while the verify was in flight.
 */
export async function verifyCredential(hasher, account, secret, now = Date.now()) {
  const credential = activeCredential(account, now);
  if (!credential.kind || typeof secret !== "string" || secret === "" || secret.length > MAX_SECRET_CHARS) {
    await hasher.burn();
    return { ok: false, cause: credential.cause ?? "wrong_secret", kind: credential.kind, hash: credential.hash ?? null };
  }
  const input = credential.kind === "setup_code" ? normalizeSetupCode(secret) : secret;
  const ok = await hasher.verify(input, credential.hash);
  return { ok, cause: ok ? null : "wrong_secret", kind: credential.kind, hash: credential.hash };
}

/** What an admin may see about an account. Never a hash. */
export function accountSummary(account, now = Date.now()) {
  const credential = activeCredential(account, now);
  return {
    id: account.id,
    username: account.username,
    name: account.name,
    role: account.role,
    disabled: account.disabled,
    locked: isLocked(account, now),
    locked_until: isLocked(account, now) ? account.lockedUntil : null,
    failed_logins: account.failedLogins,
    // No password yet: only a setup code (or nothing) lets this person in.
    needs_setup: account.passwordHash === null,
    setup_code_active: credential.kind === "setup_code",
    setup_code_expires_at: credential.kind === "setup_code" ? account.setupCodeExpiresAt : null,
    must_change_password: account.mustChangePassword,
    password_changed_at: account.passwordChangedAt,
    created_at: account.createdAt,
  };
}

export function listAccounts(db) {
  return statement(db, SELECT_ACCOUNTS).all().map(toAccount);
}

function lockoutSeconds(settings, lockoutCount) {
  // 2 ** n overflows to Infinity long before it matters; min() caps it.
  return Math.min(settings.lockoutBaseSeconds * 2 ** lockoutCount, settings.lockoutMaxSeconds);
}

/**
 * Count one failed login. The `lockoutThreshold`-th consecutive failure locks
 * the account and audits auth.lockout HERE, where the lock is decided.
 * Returns { lockedNow, lockedUntil }.
 */
export function recordLoginFailure(db, settings, accountId, { clientIp = "", now = Date.now() } = {}) {
  return inTransaction(
    db,
    () => {
      const account = loadAccount(db, accountId);
      if (!account || isLocked(account, now)) return { lockedNow: false, lockedUntil: account?.lockedUntil ?? null };
      const failures = account.failedLogins + 1;
      if (failures < settings.lockoutThreshold) {
        statement(db, UPDATE_ACCOUNT_LOGIN_FAILURE).run(failures, null, account.lockoutCount, account.id);
        return { lockedNow: false, lockedUntil: null };
      }
      const seconds = lockoutSeconds(settings, account.lockoutCount);
      const lockedUntil = isoAt(now + seconds * 1000);
      statement(db, UPDATE_ACCOUNT_LOGIN_FAILURE).run(0, lockedUntil, account.lockoutCount + 1, account.id);
      writeAudit(db, {
        actorKind: "system",
        actorName: "lockout",
        action: AuditAction.LOCKOUT,
        subjectType: "account",
        subjectId: account.id,
        outcome: "locked",
        detail: {
          username: account.username,
          failures,
          lockout_number: account.lockoutCount + 1,
          locked_seconds: seconds,
          locked_until: lockedUntil,
        },
        clientIp,
      });
      return { lockedNow: true, lockedUntil };
    },
    { immediate: true },
  );
}

export function recordLoginSuccess(db, accountId) {
  statement(db, UPDATE_ACCOUNT_LOGIN_SUCCESS).run(accountId);
}

/** End every session of the account (logout from all devices). */
export function bumpSessionVersion(db, accountId) {
  statement(db, UPDATE_ACCOUNT_BUMP_SESSION).run(accountId);
}

function auditActor(actor) {
  return { actorKind: actor.kind, actorName: actor.name, clientIp: actor.clientIp ?? "" };
}

/** Throw the 409 for a business-rule refusal, after auditing it (outside any transaction). */
function refuse(db, actor, target, action, reason) {
  writeAudit(db, {
    ...auditActor(actor),
    action: AuditAction.ACCESS_DENIED,
    subjectType: "account",
    subjectId: target,
    outcome: "denied",
    detail: { reason, action },
  });
  throw new HttpError(409, reason);
}

/**
 * Create an account with a fresh one-time setup code. Returns
 * { account, setupCode, expiresAt } — the code exists in plaintext only in
 * this return value; the caller shows it once and never logs it.
 *
 * `actor` is { kind, name, clientIp } of whoever is creating it.
 */
export async function createAccount(db, hasher, settings, { username, name, role }, actor) {
  const cleanUsername = parseUsername(username);
  const cleanName = parseMemberName(name);
  const cleanRole = parseRole(role ?? Role.MEMBER);
  const setupCode = generateSetupCode();
  const codeHash = await hasher.hash(normalizeSetupCode(setupCode));
  const now = Date.now();
  const expiresAt = isoAt(now + settings.setupCodeTtlSeconds * 1000);

  const id = inTransaction(
    db,
    () => {
      if (statement(db, SELECT_ACCOUNT_BY_USERNAME).get(cleanUsername)) throw new HttpError(409, "username_taken");
      if (statement(db, SELECT_MEMBER_BY_KEY).get(memberNameKey(cleanName))) throw new HttpError(409, "name_taken");
      const inserted = statement(db, INSERT_ACCOUNT).run(
        cleanName,
        memberNameKey(cleanName),
        utcNowIso(),
        cleanUsername,
        null,
        cleanRole,
        1,
        codeHash,
        expiresAt,
        null,
      );
      const newId = Number(inserted.lastInsertRowid);
      writeAudit(db, {
        ...auditActor(actor),
        action: AuditAction.ACCOUNT_CREATED,
        subjectType: "account",
        subjectId: newId,
        outcome: "created",
        detail: { username: cleanUsername, name: cleanName, role: cleanRole, source: "admin", setup_code_expires_at: expiresAt },
      });
      return newId;
    },
    { immediate: true },
  );
  return { account: loadAccount(db, id), setupCode, expiresAt };
}

/**
 * Reset: issue a new one-time setup code. Clears the password, forces a
 * password change, unlocks, and ends every existing session of the account.
 * Returns { setupCode, expiresAt }.
 */
export async function issueSetupCode(db, hasher, settings, targetId, actor, { source = "admin" } = {}) {
  if (!loadAccount(db, targetId)) throw new HttpError(404, "member_not_found");
  const setupCode = generateSetupCode();
  const codeHash = await hasher.hash(normalizeSetupCode(setupCode));
  const expiresAt = isoAt(Date.now() + settings.setupCodeTtlSeconds * 1000);
  inTransaction(
    db,
    () => {
      const target = loadAccount(db, targetId);
      if (!target) throw new HttpError(404, "member_not_found");
      statement(db, UPDATE_ACCOUNT_SETUP_CODE).run(codeHash, expiresAt, target.id);
      writeAudit(db, {
        ...auditActor(actor),
        action: AuditAction.PASSWORD_RESET_ISSUED,
        subjectType: "account",
        subjectId: target.id,
        outcome: "success",
        detail: { username: target.username, source, setup_code_expires_at: expiresAt },
      });
    },
    { immediate: true },
  );
  return { setupCode, expiresAt };
}

/**
 * Change the password of `account` (a fresh row from the session gate).
 * `current` is the current password — or the setup code while the account is
 * still on one. A wrong `current` counts toward the account lockout like a
 * failed login. Returns the updated account (with its new session_version).
 */
export async function changePassword(db, hasher, settings, account, { current, next }, actor) {
  const audit = (outcome, detail) =>
    writeAudit(db, {
      ...auditActor(actor),
      action: AuditAction.PASSWORD_CHANGED,
      subjectType: "account",
      subjectId: account.id,
      outcome,
      detail: { username: account.username, ...detail },
    });

  if (isLocked(account)) {
    audit("failure", { reason: "locked" });
    throw new HttpError(423, "account_locked");
  }
  const checked = await verifyCredential(hasher, account, current);
  if (!checked.ok) {
    recordLoginFailure(db, settings, account.id, { clientIp: actor.clientIp });
    audit("failure", { reason: "bad_credentials", cause: checked.cause });
    throw new HttpError(400, "current_password_wrong");
  }
  try {
    checkPasswordPolicy(next, account.username);
    if (next === current) throw new HttpError(400, "password_unchanged");
  } catch (error) {
    if (error instanceof HttpError) audit("failure", { reason: "policy", code: error.detail });
    throw error;
  }

  const newHash = await hasher.hash(next);
  const changed = inTransaction(
    db,
    () => {
      const result = statement(db, UPDATE_ACCOUNT_PASSWORD).run(newHash, utcNowIso(), account.id, checked.hash);
      if (Number(result.changes) !== 1) return false;
      audit("success", { via: checked.kind });
      return true;
    },
    { immediate: true },
  );
  if (!changed) {
    // The credential was reset or changed while this request was hashing.
    audit("failure", { reason: "credential_changed" });
    throw new HttpError(409, "credential_changed");
  }
  return loadAccount(db, account.id);
}

/** Admin unlock: clears the lock and the failure counters. */
export function unlockAccount(db, targetId, actor) {
  const target = loadAccount(db, targetId);
  if (!target) throw new HttpError(404, "member_not_found");
  inTransaction(db, () => {
    statement(db, UPDATE_ACCOUNT_UNLOCK).run(target.id);
    writeAudit(db, {
      ...auditActor(actor),
      action: AuditAction.MEMBER_UNLOCKED,
      subjectType: "account",
      subjectId: target.id,
      outcome: "success",
      detail: { username: target.username, was_locked: isLocked(target), failed_logins: target.failedLogins },
    });
  });
  return loadAccount(db, target.id);
}

/**
 * Disable or enable an account. An admin cannot disable themselves, and the
 * last active admin cannot be disabled. Both refusals are audited.
 */
export function setAccountDisabled(db, targetId, disabled, actor) {
  const outcome = inTransaction(
    db,
    () => {
      const target = loadAccount(db, targetId);
      if (!target) return { error: new HttpError(404, "member_not_found") };
      if (target.disabled === disabled) return { account: target };
      if (disabled && target.id === actor.memberId) return { conflict: "cannot_disable_self" };
      if (disabled && target.role === Role.ADMIN && countActiveAdmins(db) <= 1) return { conflict: "last_admin" };
      statement(db, UPDATE_ACCOUNT_DISABLED).run(disabled ? 1 : 0, target.id);
      writeAudit(db, {
        ...auditActor(actor),
        action: disabled ? AuditAction.MEMBER_DISABLED : AuditAction.MEMBER_ENABLED,
        subjectType: "account",
        subjectId: target.id,
        outcome: "success",
        detail: { username: target.username },
      });
      return { account: loadAccount(db, target.id) };
    },
    { immediate: true },
  );
  if (outcome.error) throw outcome.error;
  if (outcome.conflict) refuse(db, actor, targetId, disabled ? "disable" : "enable", outcome.conflict);
  return outcome.account;
}

/** Change an account's role. The last active admin cannot be demoted. */
export function setAccountRole(db, targetId, role, actor) {
  const newRole = parseRole(role);
  const outcome = inTransaction(
    db,
    () => {
      const target = loadAccount(db, targetId);
      if (!target) return { error: new HttpError(404, "member_not_found") };
      if (target.role === newRole) return { account: target };
      if (target.role === Role.ADMIN && !target.disabled && countActiveAdmins(db) <= 1) return { conflict: "last_admin" };
      statement(db, UPDATE_ACCOUNT_ROLE).run(newRole, target.id);
      writeAudit(db, {
        ...auditActor(actor),
        action: AuditAction.MEMBER_ROLE_CHANGED,
        subjectType: "account",
        subjectId: target.id,
        outcome: "success",
        detail: { username: target.username, from: target.role, to: newRole },
      });
      return { account: loadAccount(db, target.id) };
    },
    { immediate: true },
  );
  if (outcome.error) throw outcome.error;
  if (outcome.conflict) refuse(db, actor, targetId, "role", outcome.conflict);
  return outcome.account;
}

/** Change the display name (e.g. the bootstrap admin's placeholder "admin"). */
export function renameAccount(db, targetId, rawName, actor) {
  const name = parseMemberName(rawName);
  return inTransaction(
    db,
    () => {
      const target = loadAccount(db, targetId);
      if (!target) throw new HttpError(404, "member_not_found");
      if (target.name === name) return target;
      const holder = statement(db, SELECT_MEMBER_BY_KEY).get(memberNameKey(name));
      if (holder && Number(holder.id) !== target.id) throw new HttpError(409, "name_taken");
      statement(db, UPDATE_ACCOUNT_NAME).run(name, memberNameKey(name), target.id);
      writeAudit(db, {
        ...auditActor(actor),
        action: AuditAction.MEMBER_RENAMED,
        subjectType: "account",
        subjectId: target.id,
        outcome: "success",
        detail: { username: target.username, from: target.name, to: name },
      });
      return loadAccount(db, target.id);
    },
    { immediate: true },
  );
}

/**
 * Change the login name — e.g. a migrated member's placeholder "member<id>"
 * before their setup code is issued. Same rules as at creation; ends the
 * account's sessions.
 */
export function changeUsername(db, targetId, rawUsername, actor) {
  const username = parseUsername(rawUsername);
  return inTransaction(
    db,
    () => {
      const target = loadAccount(db, targetId);
      if (!target) throw new HttpError(404, "member_not_found");
      if (target.username === username) return target;
      const holder = statement(db, SELECT_ACCOUNT_BY_USERNAME).get(username);
      if (holder && Number(holder.id) !== target.id) throw new HttpError(409, "username_taken");
      statement(db, UPDATE_ACCOUNT_USERNAME).run(username, target.id);
      writeAudit(db, {
        ...auditActor(actor),
        action: AuditAction.MEMBER_USERNAME_CHANGED,
        subjectType: "account",
        subjectId: target.id,
        outcome: "success",
        detail: { from: target.username, to: username },
      });
      return loadAccount(db, target.id);
    },
    { immediate: true },
  );
}

export function adminExists(db) {
  return Number(statement(db, COUNT_ADMINS).get().n) > 0;
}

/**
 * First start with no admin account: create username "admin" whose password
 * is ADMIN_PASSWORD and must be changed at first login. Returns the new
 * account, or null when an admin already exists (ADMIN_PASSWORD is then
 * ignored). Synchronous: it runs inside the synchronous app factory.
 */
export function bootstrapAdmin(db, hasher, settings) {
  if (adminExists(db)) {
    if (settings.adminPasswordSet) {
      logger.info("ADMIN_PASSWORD is set but an admin account already exists; it is ignored (bootstrap-only).");
    }
    return null;
  }
  const passwordHash = hasher.hashSync(settings.adminPassword);
  const id = inTransaction(
    db,
    () => {
      if (adminExists(db)) return null;
      if (statement(db, SELECT_ACCOUNT_BY_USERNAME).get(BOOTSTRAP_USERNAME)) {
        throw new Error(
          "admin bootstrap: no admin account exists but the username \"" + BOOTSTRAP_USERNAME +
            "\" is taken; promote an account with `npm run admin:reset` after fixing roles in the database",
        );
      }
      const name =
        BOOTSTRAP_NAMES.find((candidate) => !statement(db, SELECT_MEMBER_BY_KEY).get(memberNameKey(candidate))) ??
        "admin-" + Date.now().toString(36);
      const inserted = statement(db, INSERT_ACCOUNT).run(
        name,
        memberNameKey(name),
        utcNowIso(),
        BOOTSTRAP_USERNAME,
        passwordHash,
        Role.ADMIN,
        1,
        null,
        null,
        null,
      );
      const newId = Number(inserted.lastInsertRowid);
      writeAudit(db, {
        actorKind: "system",
        actorName: "bootstrap",
        action: AuditAction.ACCOUNT_CREATED,
        subjectType: "account",
        subjectId: newId,
        outcome: "created",
        detail: { username: BOOTSTRAP_USERNAME, name, role: Role.ADMIN, source: "bootstrap" },
      });
      return newId;
    },
    { immediate: true },
  );
  if (id === null) return null;
  logger.warning(
    "created the first admin account (username \"" + BOOTSTRAP_USERNAME +
      "\") from ADMIN_PASSWORD; it must be changed at first login. ADMIN_PASSWORD is ignored from now on.",
  );
  return loadAccount(db, id);
}
