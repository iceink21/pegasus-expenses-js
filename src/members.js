// Member display names → one members row per person. (Login accounts on the
// same rows live in accounts.js.)
//
// A name is normalized (Unicode NFC, zero-width characters removed, internal
// whitespace collapsed, trimmed) and then matched case-insensitively through
// `name_key`. Lookup-or-create is INSERT OR IGNORE against the UNIQUE index on
// name_key, so two submits racing on the same new name produce one row: the
// loser's insert is ignored and both read back the same id. The index, not
// the single-threaded event loop, is the guarantee, so it also holds across
// processes sharing the database file.

import { AuditAction, utcNowIso, writeAudit } from "./audit.js";
import { inTransaction, statement } from "./db/connection.js";
import {
  INSERT_MEMBER_IF_NEW,
  SELECT_MEMBER_BY_KEY,
  SELECT_MEMBER_NAMES,
} from "./db/sql.js";
import { HttpError } from "./http-error.js";

export const MEMBER_NAME_MAX_CHARS = 60;
// Refuse absurd inputs before normalizing them.
const RAW_INPUT_MAX_CHARS = 1000;

// Invisible joiners/spaces that would let "ติ้ว" and "ติ้ว\u200B" become two
// members that look identical. Removed rather than rejected: they arrive by
// copy-paste from chat apps without the person knowing.
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/gu;
const WHITESPACE_RUN = /\s+/gu;
// Control, remaining format (bidi overrides, soft hyphen…), private-use and
// lone-surrogate code points.
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/u;

/** Display form of a typed name. Does not validate. */
export function normalizeMemberName(raw) {
  return String(raw).normalize("NFC").replace(ZERO_WIDTH, "").replace(WHITESPACE_RUN, " ").trim();
}

/** Case-insensitive match key for an already-normalized name. */
export function memberNameKey(name) {
  return name.toLowerCase().normalize("NFC");
}

/** Normalize + validate a name from a request. Throws HttpError(400) with a Thai-mapped code. */
export function parseMemberName(raw) {
  if (typeof raw !== "string") throw new HttpError(400, "member_name_required");
  if (raw.length > RAW_INPUT_MAX_CHARS) throw new HttpError(400, "member_name_too_long");
  const name = normalizeMemberName(raw);
  if (name === "") throw new HttpError(400, "member_name_required");
  if (FORBIDDEN.test(name)) throw new HttpError(400, "member_name_invalid");
  if ([...name].length > MEMBER_NAME_MAX_CHARS) throw new HttpError(400, "member_name_too_long");
  return name;
}

/**
 * Find the member for a normalized name, creating it if new. No transaction
 * of its own: the caller provides one (the migration runs this inside its own).
 * A creation is audited here, at the point it happens.
 */
export function resolveOrCreateMemberInTx(db, typed, { actorKind, actorName, clientIp = "", source }) {
  // Normalized here too, so no caller can create a second spelling by
  // forgetting to; validation stays the caller's job (parseMemberName).
  const name = normalizeMemberName(typed);
  const key = memberNameKey(name);
  const existing = statement(db, SELECT_MEMBER_BY_KEY).get(key);
  if (existing) return Object.freeze({ id: Number(existing.id), name: String(existing.name), created: false });
  // Look up first only to avoid burning an AUTOINCREMENT id on every repeat
  // login; the INSERT OR IGNORE + UNIQUE index is what settles a race.
  const inserted = statement(db, INSERT_MEMBER_IF_NEW).run(name, key, utcNowIso());
  const row = statement(db, SELECT_MEMBER_BY_KEY).get(key);
  const created = Number(inserted.changes) === 1;
  if (created) {
    writeAudit(db, {
      actorKind,
      actorName,
      action: AuditAction.MEMBER_CREATED,
      subjectType: "member",
      subjectId: row.id,
      outcome: "created",
      detail: { name: row.name, source },
      clientIp,
    });
  }
  return Object.freeze({ id: Number(row.id), name: String(row.name), created });
}

export function resolveOrCreateMember(db, name, audit) {
  return inTransaction(db, () => resolveOrCreateMemberInTx(db, name, audit), { immediate: true });
}

/** Existing member for a typed name, or null. Never creates. */
export function findMemberByName(db, typed) {
  const row = statement(db, SELECT_MEMBER_BY_KEY).get(memberNameKey(normalizeMemberName(typed)));
  return row ? Object.freeze({ id: Number(row.id), name: String(row.name) }) : null;
}

export function listMemberNames(db) {
  return statement(db, SELECT_MEMBER_NAMES).all().map((row) => String(row.name));
}
