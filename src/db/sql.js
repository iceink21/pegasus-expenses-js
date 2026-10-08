// Every statement is a module-level constant executed with bound parameters.
// Query text is never assembled at the call site.

// Members are typed, not picked from a list. `name` is the display form
// (NFC, trimmed, internal whitespace collapsed); `name_key` is its lower-cased
// form, and the UNIQUE index on it is what makes "Tiw", " tiw " and "TIW" one
// member even when two requests insert at the same moment.
export const SCHEMA_MEMBERS = `
CREATE TABLE IF NOT EXISTS members (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    name_key    TEXT    NOT NULL,
    created_at  TEXT    NOT NULL
)`;

export const SCHEMA_IDX_MEMBER_KEY =
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_members_name_key ON members(name_key)";

// member_id is the LAST column so a fresh database and one migrated with
// ALTER TABLE ADD COLUMN (src/db/migrate.js) end up with the same layout.
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
    member_id            INTEGER REFERENCES members(id)
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
export const SELECT_UNLINKED_MEMBER_NAMES =
  "SELECT DISTINCT member_name FROM expenses WHERE member_id IS NULL ORDER BY member_name";
export const UPDATE_LINK_EXPENSES_TO_MEMBER =
  "UPDATE expenses SET member_id = ? WHERE member_id IS NULL AND member_name = ?";

// --- members ------------------------------------------------------------
export const INSERT_MEMBER_IF_NEW =
  "INSERT OR IGNORE INTO members (name, name_key, created_at) VALUES (?, ?, ?)";
export const SELECT_MEMBER_BY_KEY = "SELECT id, name FROM members WHERE name_key = ?";
export const SELECT_MEMBER_BY_ID = "SELECT id, name FROM members WHERE id = ?";
export const SELECT_MEMBER_NAMES = "SELECT name FROM members ORDER BY name";

// --- expenses -----------------------------------------------------------
export const INSERT_EXPENSE = `
INSERT INTO expenses (
    created_at, member_name, category, note, claimed_amount,
    extracted_amount, extraction_source, extraction_detail,
    verdict, flagged, flag_reason, image_sha256, duplicate_of_id,
    evidence_backend, evidence_ref, evidence_url, member_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export const SELECT_EXPENSE_BY_ID = "SELECT * FROM expenses WHERE id = ?";
export const SELECT_EXPENSES_ALL = "SELECT * FROM expenses ORDER BY id DESC LIMIT ?";
export const SELECT_EXPENSES_BY_MEMBER_ID =
  "SELECT * FROM expenses WHERE member_id = ? ORDER BY id DESC LIMIT ?";
export const SELECT_EXPENSES_FLAGGED =
  "SELECT * FROM expenses WHERE flagged = 1 ORDER BY id DESC LIMIT ?";
export const SELECT_EXPENSES_EXPORT = "SELECT * FROM expenses ORDER BY id ASC";
export const SELECT_FIRST_BY_SHA =
  "SELECT * FROM expenses WHERE image_sha256 = ? ORDER BY id ASC LIMIT 1";
// Every member, including ones with no expense yet: this is also the admin's
// member list.
export const SELECT_TOTALS_BY_MEMBER = `
SELECT m.id AS member_id, m.name AS member_name,
       COUNT(e.id) AS n, COALESCE(SUM(e.claimed_amount), 0) AS total
FROM members m LEFT JOIN expenses e ON e.member_id = m.id
GROUP BY m.id ORDER BY total DESC, m.name`;
export const SELECT_GRAND_TOTAL =
  "SELECT COALESCE(SUM(claimed_amount), 0) AS total FROM expenses";

// --- audit --------------------------------------------------------------
export const INSERT_AUDIT = `
INSERT INTO audit_log (
    ts, actor_kind, actor_name, action, subject_type, subject_id,
    outcome, detail, client_ip
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export const SELECT_AUDIT_RECENT = "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?";
