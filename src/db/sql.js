// Every statement is a module-level constant executed with bound parameters.
// Query text is never assembled at the call site.

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
    evidence_url         TEXT
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

export const SCHEMA_STATEMENTS = Object.freeze([
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
export const TX_COMMIT = "COMMIT";
export const TX_ROLLBACK = "ROLLBACK";

// --- expenses -----------------------------------------------------------
export const INSERT_EXPENSE = `
INSERT INTO expenses (
    created_at, member_name, category, note, claimed_amount,
    extracted_amount, extraction_source, extraction_detail,
    verdict, flagged, flag_reason, image_sha256, duplicate_of_id,
    evidence_backend, evidence_ref, evidence_url
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export const SELECT_EXPENSE_BY_ID = "SELECT * FROM expenses WHERE id = ?";
export const SELECT_EXPENSES_ALL = "SELECT * FROM expenses ORDER BY id DESC LIMIT ?";
export const SELECT_EXPENSES_BY_MEMBER =
  "SELECT * FROM expenses WHERE member_name = ? ORDER BY id DESC LIMIT ?";
export const SELECT_EXPENSES_FLAGGED =
  "SELECT * FROM expenses WHERE flagged = 1 ORDER BY id DESC LIMIT ?";
export const SELECT_EXPENSES_EXPORT = "SELECT * FROM expenses ORDER BY id ASC";
export const SELECT_FIRST_BY_SHA =
  "SELECT * FROM expenses WHERE image_sha256 = ? ORDER BY id ASC LIMIT 1";
export const SELECT_TOTALS_BY_MEMBER = `
SELECT member_name, COUNT(*) AS n, COALESCE(SUM(claimed_amount), 0) AS total
FROM expenses GROUP BY member_name ORDER BY total DESC`;
export const SELECT_GRAND_TOTAL =
  "SELECT COALESCE(SUM(claimed_amount), 0) AS total FROM expenses";

// --- audit --------------------------------------------------------------
export const INSERT_AUDIT = `
INSERT INTO audit_log (
    ts, actor_kind, actor_name, action, subject_type, subject_id,
    outcome, detail, client_ip
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export const SELECT_AUDIT_RECENT = "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?";
