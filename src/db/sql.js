// Every statement is a module-level constant executed with bound parameters.
// Query text is never assembled at the call site.

// Members are typed, not picked from a list. `name` is the display form
// (NFC, trimmed, internal whitespace collapsed); `name_key` is its lower-cased
// form, and the UNIQUE index on it is what makes "Tiw", " tiw " and "TIW" one
// member even when two requests insert at the same moment.
//
// Every member is also a login account. The account columns after created_at
// are appended in the order src/db/migrate.js adds them (MEMBER_ACCOUNT_COLUMN_ALTERS),
// so fresh and migrated databases have the same layout. New columns go at the END.
//   username             ASCII lower-case login name, UNIQUE (index below)
//   password_hash        "scrypt$N$r$p$salt$key", NULL until a password is set
//   role                 'member' | 'admin'
//   must_change_password 1 = the session may only change its password
//   session_version      bumped to revoke every session of the account
//   failed_logins        consecutive failures since the last success/lockout
//   locked_until         ISO time; login refused before it
//   lockout_count        lockouts since the last success (doubles the duration)
//   disabled             1 = cannot log in, existing sessions rejected
//   setup_code_hash      scrypt hash of the one-time setup code, NULL when none
export const SCHEMA_MEMBERS = `
CREATE TABLE IF NOT EXISTS members (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    name                  TEXT    NOT NULL,
    name_key              TEXT    NOT NULL,
    created_at            TEXT    NOT NULL,
    username              TEXT,
    password_hash         TEXT,
    role                  TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
    must_change_password  INTEGER NOT NULL DEFAULT 0,
    session_version       INTEGER NOT NULL DEFAULT 1,
    failed_logins         INTEGER NOT NULL DEFAULT 0,
    locked_until          TEXT,
    lockout_count         INTEGER NOT NULL DEFAULT 0,
    disabled              INTEGER NOT NULL DEFAULT 0,
    password_changed_at   TEXT,
    setup_code_hash       TEXT,
    setup_code_expires_at TEXT
)`;

export const SCHEMA_IDX_MEMBER_KEY =
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_members_name_key ON members(name_key)";

// member_id and the review columns after it are appended in the order
// src/db/migrate.js adds them with ALTER TABLE ADD COLUMN, so a fresh database
// and a migrated one end up with the same layout. New columns go at the END.
//
// review_status: verified (MATCH, no flag — never needs a human) | pending
// (routed to needs-review) | approved | rejected (set by an admin review).
// evidence_folder: verified | needs-review | rejected | legacy (stored before
// routing; the file was never moved). approved_amount is the admin's figure;
// claimed_amount and verdict are never rewritten by a review.
export const SCHEMA_EXPENSES = `
CREATE TABLE IF NOT EXISTS expenses (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at           TEXT    NOT NULL,
    member_name          TEXT    NOT NULL,
    category             TEXT    NOT NULL,
    note                 TEXT    NOT NULL DEFAULT '',
    claimed_amount       REAL    NOT NULL,
    extracted_amount     REAL,
    extraction_source    TEXT    NOT NULL,
    extraction_detail    TEXT    NOT NULL DEFAULT '',
    verdict              TEXT    NOT NULL,
    flagged              INTEGER NOT NULL DEFAULT 0,
    flag_reason          TEXT,
    image_sha256         TEXT    NOT NULL,
    duplicate_of_id      INTEGER,
    evidence_backend     TEXT    NOT NULL,
    evidence_ref         TEXT    NOT NULL,
    evidence_url         TEXT,
    member_id            INTEGER REFERENCES members(id),
    review_status        TEXT,
    evidence_folder      TEXT,
    approved_amount      REAL,
    reviewed_by          TEXT,
    reviewed_at          TEXT,
    review_note          TEXT
)`;

export const SCHEMA_AUDIT = `
CREATE TABLE IF NOT EXISTS audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            TEXT    NOT NULL,
    actor_kind    TEXT    NOT NULL,
    actor_name    TEXT    NOT NULL,
    action        TEXT    NOT NULL,
    subject_type  TEXT    NOT NULL,
    subject_id    TEXT,
    outcome       TEXT    NOT NULL,
    detail        TEXT    NOT NULL DEFAULT '',
    client_ip     TEXT    NOT NULL DEFAULT ''
)`;

export const SCHEMA_IDX_SHA =
  "CREATE INDEX IF NOT EXISTS idx_expenses_sha ON expenses(image_sha256)";
export const SCHEMA_IDX_MEMBER =
  "CREATE INDEX IF NOT EXISTS idx_expenses_member ON expenses(member_name)";
export const SCHEMA_IDX_AUDIT_TS = "CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts)";

// member_id indexes are created by the migration, after the column exists.
export const SCHEMA_STATEMENTS = Object.freeze([
  SCHEMA_MEMBERS,
  SCHEMA_IDX_MEMBER_KEY,
  SCHEMA_EXPENSES,
  SCHEMA_AUDIT,
  SCHEMA_IDX_SHA,
  SCHEMA_IDX_MEMBER,
  SCHEMA_IDX_AUDIT_TS,
]);

export const PRAGMA_WAL = "PRAGMA journal_mode=WAL";
export const PRAGMA_FOREIGN_KEYS = "PRAGMA foreign_keys=ON";
export const PRAGMA_BUSY_TIMEOUT = "PRAGMA busy_timeout=15000";

export const TX_BEGIN = "BEGIN";
// Takes the write lock up front. Needed by a transaction that reads before it
// writes: a deferred one cannot upgrade once another connection has committed
// (SQLITE_BUSY, which busy_timeout does not retry).
export const TX_BEGIN_IMMEDIATE = "BEGIN IMMEDIATE";
export const TX_COMMIT = "COMMIT";
export const TX_ROLLBACK = "ROLLBACK";

// --- migration (src/db/migrate.js) -------------------------------------
export const SELECT_EXPENSE_COLUMNS = "SELECT name FROM pragma_table_info('expenses')";
export const ALTER_EXPENSES_ADD_MEMBER_ID =
  "ALTER TABLE expenses ADD COLUMN member_id INTEGER REFERENCES members(id)";
export const SCHEMA_IDX_EXPENSES_MEMBER_ID =
  "CREATE INDEX IF NOT EXISTS idx_expenses_member_id ON expenses(member_id)";
// Review columns, in table order. [column name, ALTER statement].
export const REVIEW_COLUMN_ALTERS = Object.freeze([
  ["review_status", "ALTER TABLE expenses ADD COLUMN review_status TEXT"],
  ["evidence_folder", "ALTER TABLE expenses ADD COLUMN evidence_folder TEXT"],
  ["approved_amount", "ALTER TABLE expenses ADD COLUMN approved_amount REAL"],
  ["reviewed_by", "ALTER TABLE expenses ADD COLUMN reviewed_by TEXT"],
  ["reviewed_at", "ALTER TABLE expenses ADD COLUMN reviewed_at TEXT"],
  ["review_note", "ALTER TABLE expenses ADD COLUMN review_note TEXT"],
]);
// Rows from before routing: a clean MATCH counts as verified, anything else
// waits for a human. Their files stay where they are ("legacy").
export const UPDATE_BACKFILL_REVIEW_STATUS = `
UPDATE expenses
SET review_status = CASE WHEN verdict = 'MATCH' AND flagged = 0 THEN 'verified' ELSE 'pending' END,
    evidence_folder = COALESCE(evidence_folder, 'legacy')
WHERE review_status IS NULL`;
export const SELECT_UNLINKED_MEMBER_NAMES =
  "SELECT DISTINCT member_name FROM expenses WHERE member_id IS NULL ORDER BY member_name";
export const UPDATE_LINK_EXPENSES_TO_MEMBER =
  "UPDATE expenses SET member_id = ? WHERE member_id IS NULL AND member_name = ?";

// Account columns on members, in table order. [column name, ALTER statement].
export const SELECT_MEMBER_COLUMNS = "SELECT name FROM pragma_table_info('members')";
export const MEMBER_ACCOUNT_COLUMN_ALTERS = Object.freeze([
  ["username", "ALTER TABLE members ADD COLUMN username TEXT"],
  ["password_hash", "ALTER TABLE members ADD COLUMN password_hash TEXT"],
  ["role", "ALTER TABLE members ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin'))"],
  ["must_change_password", "ALTER TABLE members ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0"],
  ["session_version", "ALTER TABLE members ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1"],
  ["failed_logins", "ALTER TABLE members ADD COLUMN failed_logins INTEGER NOT NULL DEFAULT 0"],
  ["locked_until", "ALTER TABLE members ADD COLUMN locked_until TEXT"],
  ["lockout_count", "ALTER TABLE members ADD COLUMN lockout_count INTEGER NOT NULL DEFAULT 0"],
  ["disabled", "ALTER TABLE members ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0"],
  ["password_changed_at", "ALTER TABLE members ADD COLUMN password_changed_at TEXT"],
  ["setup_code_hash", "ALTER TABLE members ADD COLUMN setup_code_hash TEXT"],
  ["setup_code_expires_at", "ALTER TABLE members ADD COLUMN setup_code_expires_at TEXT"],
]);
export const SCHEMA_IDX_MEMBER_USERNAME =
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_members_username ON members(username)";
// Members from before accounts get a placeholder login name and no
// credential: nobody can log in as them until an admin issues a setup code.
export const UPDATE_BACKFILL_USERNAMES =
  "UPDATE members SET username = 'member' || id WHERE username IS NULL";

// --- members ------------------------------------------------------------
export const INSERT_MEMBER_IF_NEW =
  "INSERT OR IGNORE INTO members (name, name_key, created_at) VALUES (?, ?, ?)";
export const SELECT_MEMBER_BY_KEY = "SELECT id, name FROM members WHERE name_key = ?";
export const SELECT_MEMBER_NAMES = "SELECT name FROM members ORDER BY name";
export const SELECT_MEMBER_CHOICES = "SELECT id, name FROM members ORDER BY name";

// --- accounts (src/accounts.js) ------------------------------------------
export const SELECT_ACCOUNT_BY_ID = "SELECT * FROM members WHERE id = ?";
export const SELECT_ACCOUNT_BY_USERNAME = "SELECT * FROM members WHERE username = ?";
export const SELECT_ACCOUNTS = "SELECT * FROM members ORDER BY role DESC, name";
export const COUNT_ADMINS = "SELECT COUNT(*) AS n FROM members WHERE role = 'admin'";
export const COUNT_ACTIVE_ADMINS =
  "SELECT COUNT(*) AS n FROM members WHERE role = 'admin' AND disabled = 0";
export const INSERT_ACCOUNT = `
INSERT INTO members (
    name, name_key, created_at, username, password_hash, role,
    must_change_password, setup_code_hash, setup_code_expires_at, password_changed_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
// Clears any password: until the code is used, only the code logs in.
export const UPDATE_ACCOUNT_SETUP_CODE = `
UPDATE members
SET password_hash = NULL, setup_code_hash = ?, setup_code_expires_at = ?,
    must_change_password = 1, session_version = session_version + 1,
    failed_logins = 0, locked_until = NULL, lockout_count = 0
WHERE id = ?`;
// The "AND COALESCE(...) = ?" re-check makes the write fail (0 rows) if the
// credential the caller verified was replaced in the meantime.
export const UPDATE_ACCOUNT_PASSWORD = `
UPDATE members
SET password_hash = ?, setup_code_hash = NULL, setup_code_expires_at = NULL,
    must_change_password = 0, session_version = session_version + 1,
    password_changed_at = ?, failed_logins = 0, locked_until = NULL, lockout_count = 0
WHERE id = ? AND COALESCE(password_hash, setup_code_hash, '') = ?`;
export const UPDATE_ACCOUNT_LOGIN_FAILURE =
  "UPDATE members SET failed_logins = ?, locked_until = ?, lockout_count = ? WHERE id = ?";
export const UPDATE_ACCOUNT_LOGIN_SUCCESS =
  "UPDATE members SET failed_logins = 0, locked_until = NULL, lockout_count = 0 WHERE id = ?";
export const UPDATE_ACCOUNT_UNLOCK =
  "UPDATE members SET failed_logins = 0, locked_until = NULL, lockout_count = 0 WHERE id = ?";
export const UPDATE_ACCOUNT_DISABLED =
  "UPDATE members SET disabled = ?, session_version = session_version + 1 WHERE id = ?";
export const UPDATE_ACCOUNT_ROLE =
  "UPDATE members SET role = ?, session_version = session_version + 1 WHERE id = ?";
export const UPDATE_ACCOUNT_NAME = "UPDATE members SET name = ?, name_key = ? WHERE id = ?";
// A new login name ends the account's sessions (they were issued to the old one).
export const UPDATE_ACCOUNT_USERNAME =
  "UPDATE members SET username = ?, session_version = session_version + 1 WHERE id = ?";
export const UPDATE_ACCOUNT_BUMP_SESSION =
  "UPDATE members SET session_version = session_version + 1 WHERE id = ?";

// --- expenses -----------------------------------------------------------
export const INSERT_EXPENSE = `
INSERT INTO expenses (
    created_at, member_name, category, note, claimed_amount,
    extracted_amount, extraction_source, extraction_detail,
    verdict, flagged, flag_reason, image_sha256, duplicate_of_id,
    evidence_backend, evidence_ref, evidence_url, member_id,
    review_status, evidence_folder
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// Other rows pointing at the same stored file. Before 2026-10-20 a duplicate
// reused its original's evidence ref, so legacy rows can share one file; a
// review must then copy rather than move it.
export const SELECT_OTHER_ROWS_SHARING_EVIDENCE =
  "SELECT id FROM expenses WHERE evidence_backend = ? AND evidence_ref = ? AND id <> ? ORDER BY id";

// The review write. `review_status = 'pending'` in the WHERE is the re-check:
// zero changed rows means someone else reviewed it first.
export const UPDATE_EXPENSE_REVIEW = `
UPDATE expenses
SET review_status = ?, approved_amount = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?,
    evidence_backend = ?, evidence_ref = ?, evidence_url = ?, evidence_folder = ?
WHERE id = ? AND review_status = 'pending'`;

/** Display name for a member's evidence folder (read server-side, never from a request). */
export const SELECT_MEMBER_NAME = "SELECT id, name FROM members WHERE id = ?";

export const SELECT_EXPENSE_BY_ID = "SELECT * FROM expenses WHERE id = ?";
export const SELECT_EXPENSES_ALL = "SELECT * FROM expenses ORDER BY id DESC LIMIT ?";
export const SELECT_EXPENSES_BY_MEMBER_ID =
  "SELECT * FROM expenses WHERE member_id = ? ORDER BY id DESC LIMIT ?";
export const SELECT_EXPENSES_FLAGGED =
  "SELECT * FROM expenses WHERE flagged = 1 ORDER BY id DESC LIMIT ?";
// Admin claims list. Both filters optional (NULL = no filter): evidence_folder
// exactly, member_name as a substring (the caller escapes % _ \\ with \\).
export const SELECT_EXPENSES_FILTERED = `
SELECT id, created_at, member_name, category, claimed_amount, extracted_amount,
       approved_amount, verdict, flag_reason, review_status, evidence_folder
FROM expenses
WHERE (? IS NULL OR evidence_folder = ?)
  AND (? IS NULL OR member_name LIKE ? ESCAPE '\\')
ORDER BY id DESC LIMIT ?`;
export const SELECT_EXPENSES_EXPORT = "SELECT * FROM expenses ORDER BY id ASC";
export const SELECT_FIRST_BY_SHA =
  "SELECT * FROM expenses WHERE image_sha256 = ? ORDER BY id ASC LIMIT 1";
// Every member, including ones with no expense yet: this is also the admin's
// member list. One aggregate shared by the dashboard and the xlsx export.
//   claimed_total  — everything not rejected
//   verified_total — auto-verified claims + the admin's approved_amount
//   pending/rejected — claimed amounts still waiting / turned down
// A NULL review_status (only possible if a row bypassed the migration's
// backfill) counts as pending, so no claim can drop out of every total.
// Counts use THEN e.id so a member's all-NULL LEFT JOIN row counts nothing.
export const SELECT_TOTALS_BY_MEMBER = `
SELECT m.id AS member_id, m.name AS member_name,
       COUNT(e.id) AS n,
       COALESCE(SUM(CASE WHEN COALESCE(e.review_status, 'pending') <> 'rejected' THEN e.claimed_amount END), 0) AS claimed_total,
       COALESCE(SUM(CASE COALESCE(e.review_status, 'pending')
                      WHEN 'verified' THEN e.claimed_amount
                      WHEN 'approved' THEN e.approved_amount END), 0) AS verified_total,
       COALESCE(SUM(CASE WHEN COALESCE(e.review_status, 'pending') = 'pending' THEN e.claimed_amount END), 0) AS pending_total,
       COUNT(CASE WHEN COALESCE(e.review_status, 'pending') = 'pending' THEN e.id END) AS pending_count,
       COALESCE(SUM(CASE WHEN COALESCE(e.review_status, 'pending') = 'rejected' THEN e.claimed_amount END), 0) AS rejected_total,
       COUNT(CASE WHEN COALESCE(e.review_status, 'pending') = 'rejected' THEN e.id END) AS rejected_count,
       MAX(e.created_at) AS last_upload
FROM members m LEFT JOIN expenses e ON e.member_id = m.id
GROUP BY m.id ORDER BY claimed_total DESC, m.name`;
export const SELECT_GRAND_TOTALS = `
SELECT COUNT(id) AS n,
       COALESCE(SUM(CASE WHEN COALESCE(review_status, 'pending') <> 'rejected' THEN claimed_amount END), 0) AS claimed_total,
       COALESCE(SUM(CASE COALESCE(review_status, 'pending')
                      WHEN 'verified' THEN claimed_amount
                      WHEN 'approved' THEN approved_amount END), 0) AS verified_total,
       COALESCE(SUM(CASE WHEN COALESCE(review_status, 'pending') = 'pending' THEN claimed_amount END), 0) AS pending_total,
       COUNT(CASE WHEN COALESCE(review_status, 'pending') = 'pending' THEN 1 END) AS pending_count,
       COALESCE(SUM(CASE WHEN COALESCE(review_status, 'pending') = 'rejected' THEN claimed_amount END), 0) AS rejected_total,
       COUNT(CASE WHEN COALESCE(review_status, 'pending') = 'rejected' THEN 1 END) AS rejected_count,
       MAX(created_at) AS last_upload
FROM expenses`;

// --- audit --------------------------------------------------------------
export const INSERT_AUDIT = `
INSERT INTO audit_log (
    ts, actor_kind, actor_name, action, subject_type, subject_id,
    outcome, detail, client_ip
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export const SELECT_AUDIT_RECENT = "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?";
