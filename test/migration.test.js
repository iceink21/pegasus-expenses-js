// Startup migration from the pre-members schema (src/db/migrate.js).
//
// The legacy DDL below is the schema as it shipped before typed names, copied
// verbatim, so this test keeps describing the real starting point even after
// sql.js moves on.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { buildApp } from "../src/app.js";
import { query, startApp, stubSlip, teamClient, testEnv, upload } from "./helpers.js";

const LEGACY_DDL = [
  `CREATE TABLE expenses (
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
  )`,
  `CREATE TABLE audit_log (
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
  )`,
  "CREATE INDEX idx_expenses_sha ON expenses(image_sha256)",
  "CREATE INDEX idx_expenses_member ON expenses(member_name)",
  "CREATE INDEX idx_audit_ts ON audit_log(ts)",
];

const LEGACY_INSERT = `INSERT INTO expenses (created_at, member_name, category, note, claimed_amount,
  extracted_amount, extraction_source, extraction_detail, verdict, flagged, flag_reason,
  image_sha256, duplicate_of_id, evidence_backend, evidence_ref, evidence_url)
  VALUES (?, ?, 'อะไหล่โดรน', '', ?, ?, 'ocr', '', ?, ?, ?, ?, NULL, 'local', 'x', NULL)`;

function legacyDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pegasus-legacy-"));
  const dbPath = path.join(dir, "legacy.db");
  const db = new DatabaseSync(dbPath);
  for (const ddl of LEGACY_DDL) db.prepare(ddl).run();
  const insert = db.prepare(LEGACY_INSERT);
  insert.run("2026-10-01T01:00:00+00:00", "ติ้ว", 100, 100, "MATCH", 0, null, "a");
  insert.run("2026-10-01T02:00:00+00:00", "ติ้ว", 200, 150, "MISMATCH", 1, "amount_mismatch", "b");
  // Same person, stored with a stray trailing space by some older client.
  insert.run("2026-10-01T03:00:00+00:00", "ติ้ว ", 50, null, "UNREADABLE", 0, null, "c");
  insert.run("2026-10-01T04:00:00+00:00", "นาย", 75, 75, "MATCH", 0, null, "d");
  db.close();
  return dbPath;
}

function boot(dbPath) {
  const built = buildApp({ env: testEnv({ DB_PATH: dbPath }) });
  built.close();
}

test("legacy expenses are linked to members; a second start changes nothing", () => {
  const dbPath = legacyDb();
  boot(dbPath);

  const members = query(dbPath, "SELECT id, name FROM members ORDER BY id").map((row) => [row.id, row.name]);
  assert.deepEqual(members, [
    [1, "ติ้ว"],
    [2, "นาย"],
  ]);
  const links = query(dbPath, "SELECT member_name, member_id FROM expenses ORDER BY id").map((row) => [
    row.member_name,
    row.member_id,
  ]);
  assert.deepEqual(links, [
    ["ติ้ว", 1],
    ["ติ้ว", 1],
    ["ติ้ว ", 1],
    ["นาย", 2],
  ]);
  // Verdicts, flags and the stored names are untouched.
  assert.deepEqual(
    query(dbPath, "SELECT verdict FROM expenses ORDER BY id").map((row) => row.verdict),
    ["MATCH", "MISMATCH", "UNREADABLE", "MATCH"],
  );
  const created = query(dbPath, "SELECT detail FROM audit_log WHERE action = 'member.created'");
  assert.equal(created.length, 2);
  assert.ok(created.every((row) => JSON.parse(row.detail).source === "migration"));
  const indexes = query(dbPath, "SELECT name FROM sqlite_master WHERE type = 'index'").map((row) => row.name);
  assert.ok(indexes.includes("idx_members_name_key") && indexes.includes("idx_expenses_member_id"));

  const snapshot = () => JSON.stringify([
    query(dbPath, "SELECT * FROM members ORDER BY id"),
    query(dbPath, "SELECT * FROM expenses ORDER BY id"),
    query(dbPath, "SELECT COUNT(*) AS n FROM audit_log"),
  ]);
  const before = snapshot();
  boot(dbPath);
  boot(dbPath);
  assert.equal(snapshot(), before, "re-running the migration changed the database");
});

test("a migrated member logs in by name and sees their old rows; new uploads reuse the id", async (t) => {
  const dbPath = legacyDb();
  const app = await startApp(t, { DB_PATH: dbPath });
  const tiw = await teamClient(app, "  ติ้ว ");
  const mine = await (await tiw.get("/api/my")).json();
  assert.deepEqual(mine.rows.map((row) => row.id), [3, 2, 1]);
  assert.ok(mine.rows.every((row) => !("verdict" in row)));

  await upload(tiw, { payload: stubSlip("PEGASUS_STUB_AMOUNT=100.00", "post-migration") });
  const [latest] = query(dbPath, "SELECT member_id FROM expenses ORDER BY id DESC LIMIT 1");
  assert.equal(latest.member_id, 1);
  assert.equal(query(dbPath, "SELECT * FROM members").length, 2);

  // The other migrated member cannot read ติ้ว's rows.
  const nai = await teamClient(app, "นาย");
  assert.equal((await nai.get("/api/expenses/1")).status, 403);
});

test("a fresh database gets the same expenses layout as a migrated one", () => {
  const fresh = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pegasus-fresh-")), "fresh.db");
  boot(fresh);
  const migrated = legacyDb();
  boot(migrated);
  const columns = (dbPath) => query(dbPath, "SELECT name FROM pragma_table_info('expenses')").map((row) => row.name);
  assert.deepEqual(columns(fresh), columns(migrated));
  assert.equal(columns(fresh).at(-1), "member_id");
});
