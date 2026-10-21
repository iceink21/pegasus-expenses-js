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
import { adminClient, login, MEMBER_PASSWORD, query, startApp, stubSlip, testEnv, upload } from "./helpers.js";

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

  const members = query(dbPath, "SELECT id, name, username, role, password_hash, setup_code_hash FROM members ORDER BY id")
    .map((row) => [row.id, row.name, row.username, row.role, row.password_hash, row.setup_code_hash]);
  assert.deepEqual(members, [
    // Migrated members: placeholder login, no credential — no login possible yet.
    [1, "ติ้ว", "member1", "member", null, null],
    [2, "นาย", "member2", "member", null, null],
  ].concat([members[2]]));
  // …and the bootstrap admin, created once from ADMIN_PASSWORD.
  assert.deepEqual(members[2].slice(0, 4), [3, "admin", "admin", "admin"]);
  assert.match(members[2][4], /^scrypt\$/);
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
  assert.ok(indexes.includes("idx_members_username"));

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

test("a migrated member logs in only after an admin issues a setup code, then sees their old rows", async (t) => {
  const dbPath = legacyDb();
  const app = await startApp(t, { DB_PATH: dbPath });
  // No credential yet: even the "right" guess fails, with the generic answer.
  const early = await login(app.client(), "member1", "");
  assert.equal(early.status, 401);

  const admin = await adminClient(app);
  const issued = await admin.postJson("/api/admin/members/1/setup-code", {});
  assert.equal(issued.status, 200);
  const { setup_code: code } = await issued.json();

  const tiw = app.client();
  const first = await login(tiw, "member1", code);
  assert.equal(first.status, 303);
  assert.equal(first.headers.get("location"), "/account/password");
  // Forced change before anything else.
  assert.equal((await tiw.get("/api/my")).status, 403);
  const changed = await tiw.postJson("/api/account/password", { current_password: code, new_password: MEMBER_PASSWORD });
  assert.equal(changed.status, 200);

  const mine = await (await tiw.get("/api/my")).json();
  assert.deepEqual(mine.rows.map((row) => row.id), [3, 2, 1]);
  assert.ok(mine.rows.every((row) => !("verdict" in row)));

  await upload(tiw, { payload: stubSlip("PEGASUS_STUB_AMOUNT=100.00", "post-migration") });
  const [latest] = query(dbPath, "SELECT member_id FROM expenses ORDER BY id DESC LIMIT 1");
  assert.equal(latest.member_id, 1);
  assert.equal(query(dbPath, "SELECT * FROM members").length, 3, "two migrated members + the admin");

  // The other migrated member cannot read ติ้ว's rows.
  const nai = app.client();
  const naiCode = (await (await admin.postJson("/api/admin/members/2/setup-code", {})).json()).setup_code;
  await login(nai, "member2", naiCode);
  await nai.postJson("/api/account/password", { current_password: naiCode, new_password: "nai-new-password-9" });
  assert.equal((await nai.get("/api/expenses/1")).status, 403);
});

test("fresh and migrated databases get the same members layout", () => {
  const fresh = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pegasus-fresh-")), "fresh.db");
  boot(fresh);
  // Migrated through the ALTER path: members exists without account columns.
  const migrated = membersOnlyDb();
  boot(migrated);
  const columns = (dbPath) => query(dbPath, "SELECT name, type, \"notnull\", dflt_value FROM pragma_table_info('members')");
  assert.deepEqual(columns(fresh), columns(migrated));
  assert.deepEqual(columns(fresh).map((column) => column.name).slice(4), [
    "username",
    "password_hash",
    "role",
    "must_change_password",
    "session_version",
    "failed_logins",
    "locked_until",
    "lockout_count",
    "disabled",
    "password_changed_at",
    "setup_code_hash",
    "setup_code_expires_at",
  ]);
});

// The members table as it is live today (typed names, no accounts).
function membersOnlyDb() {
  const dbPath = legacyDb();
  const db = new DatabaseSync(dbPath);
  db.prepare("CREATE TABLE members (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, name_key TEXT NOT NULL, created_at TEXT NOT NULL)").run();
  db.prepare("CREATE UNIQUE INDEX idx_members_name_key ON members(name_key)").run();
  db.prepare("INSERT INTO members (name, name_key, created_at) VALUES ('ติ้ว', 'ติ้ว', 't'), ('นาย', 'นาย', 't'), ('คูการ์', 'คูการ์', 't')").run();
  db.prepare("ALTER TABLE expenses ADD COLUMN member_id INTEGER").run();
  db.prepare("UPDATE expenses SET member_id = CASE WHEN member_name LIKE 'ติ้ว%' THEN 1 ELSE 2 END").run();
  db.close();
  return dbPath;
}

test("accounts migration from the live members schema keeps ids and links, and is idempotent", () => {
  const dbPath = membersOnlyDb();
  const linksBefore = query(dbPath, "SELECT id, member_id FROM expenses ORDER BY id");
  boot(dbPath);
  assert.deepEqual(query(dbPath, "SELECT id, member_id FROM expenses ORDER BY id"), linksBefore);
  assert.deepEqual(
    query(dbPath, "SELECT id, name, username, role, password_hash, must_change_password, session_version, disabled FROM members WHERE id <= 3 ORDER BY id")
      .map((row) => Object.values(row)),
    [
      [1, "ติ้ว", "member1", "member", null, 0, 1, 0],
      [2, "นาย", "member2", "member", null, 0, 1, 0],
      [3, "คูการ์", "member3", "member", null, 0, 1, 0],
    ],
  );
  const snapshot = () => JSON.stringify([
    query(dbPath, "SELECT * FROM members ORDER BY id"),
    query(dbPath, "SELECT * FROM expenses ORDER BY id"),
    query(dbPath, "SELECT COUNT(*) AS n FROM audit_log"),
  ]);
  const before = snapshot();
  boot(dbPath);
  boot(dbPath);
  assert.equal(snapshot(), before, "a second start changed the database (or bootstrapped a second admin)");
  assert.equal(query(dbPath, "SELECT COUNT(*) AS n FROM members WHERE role = 'admin'")[0].n, 1);
});

test("a fresh database gets the same expenses layout as a migrated one", () => {
  const fresh = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pegasus-fresh-")), "fresh.db");
  boot(fresh);
  const migrated = legacyDb();
  boot(migrated);
  const columns = (dbPath) => query(dbPath, "SELECT name FROM pragma_table_info('expenses')").map((row) => row.name);
  assert.deepEqual(columns(fresh), columns(migrated));
  assert.deepEqual(columns(fresh).slice(-7), [
    "member_id",
    "review_status",
    "evidence_folder",
    "approved_amount",
    "reviewed_by",
    "reviewed_at",
    "review_note",
  ]);
});

// The schema that is live today: members linked, no review columns yet.
function memberLinkedDb() {
  const dbPath = legacyDb();
  const db = new DatabaseSync(dbPath);
  db.prepare("ALTER TABLE expenses ADD COLUMN member_id INTEGER").run();
  db.close();
  return dbPath;
}

for (const [label, makeDb] of [
  ["pre-members schema", legacyDb],
  ["member-linked schema (current production)", memberLinkedDb],
]) {
  test("review backfill from the " + label + " is idempotent and moves no files", () => {
    const dbPath = makeDb();
    boot(dbPath);
    const review = () =>
      query(dbPath, "SELECT verdict, flagged, review_status, evidence_folder, approved_amount, " +
        "reviewed_by, reviewed_at, review_note, evidence_ref FROM expenses ORDER BY id");
    const rows = review();
    assert.deepEqual(
      rows.map((row) => [row.verdict, row.review_status, row.evidence_folder]),
      [
        ["MATCH", "verified", "legacy"],
        ["MISMATCH", "pending", "legacy"],
        ["UNREADABLE", "pending", "legacy"],
        ["MATCH", "verified", "legacy"],
      ],
    );
    assert.ok(rows.every((row) => row.approved_amount === null && row.reviewed_by === null &&
      row.reviewed_at === null && row.review_note === null));
    assert.ok(rows.every((row) => row.evidence_ref === "x"), "legacy evidence refs are untouched");

    const before = JSON.stringify([review(), query(dbPath, "SELECT COUNT(*) AS n FROM audit_log")]);
    boot(dbPath);
    boot(dbPath);
    assert.equal(JSON.stringify([review(), query(dbPath, "SELECT COUNT(*) AS n FROM audit_log")]), before);
  });
}
