// Member display names: normalization, validation, the uniqueness of a name
// across spellings, and the guarantee that racing creates produce one row.
// Accounts are created by an admin (POST /api/admin/members); the typed-name
// lookup-or-create below survives for the migration of legacy expense rows.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";

import { HttpError } from "../src/http-error.js";
import { memberNameKey, normalizeMemberName, parseMemberName } from "../src/members.js";
import { adminClient, ensureMember, query, startApp } from "./helpers.js";

// Excludes the bootstrap admin every test app starts with.
const MEMBERS_SQL = "SELECT * FROM members WHERE role = 'member' ORDER BY id";

test("normalization: NFC, zero-width removed, whitespace collapsed, trimmed", () => {
  // Latin e + combining acute (U+0301) composes to é under NFC.
  assert.equal(normalizeMemberName("  Jose\u0301   Tiw\t "), "José Tiw");
  assert.equal(normalizeMemberName("ติ้ว\u200B"), "ติ้ว");
  assert.equal(normalizeMemberName("\u00A0นาย\u3000"), "นาย");
  assert.equal(memberNameKey("TiW"), memberNameKey("tiw"));
});

test("validation rejects empty, control/format characters and over-long names", () => {
  const code = (raw) => {
    try {
      parseMemberName(raw);
      return "ok";
    } catch (error) {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 400);
      return error.detail;
    }
  };
  assert.equal(code(""), "member_name_required");
  assert.equal(code("   \u200B "), "member_name_required");
  assert.equal(code(undefined), "member_name_required");
  assert.equal(code("ab\u0000c"), "member_name_invalid");
  assert.equal(code("ab\u007Fc"), "member_name_invalid");
  assert.equal(code("ab\u202Ec"), "member_name_invalid");
  assert.equal(code("ab\uE000c"), "member_name_invalid");
  assert.equal(code("ก".repeat(60)), "ok");
  assert.equal(code("ก".repeat(61)), "member_name_too_long");
  assert.equal(code("x".repeat(5000)), "member_name_too_long");
  // A tab inside a name is whitespace, collapsed rather than rejected.
  assert.equal(parseMemberName("ติ้ว\tนาย"), "ติ้ว นาย");
});

const createAccount = (admin, body) => admin.postJson("/api/admin/members", body);

test("an admin-created account audits member.account_created, without the setup code", async (t) => {
  const app = await startApp(t);
  const admin = await adminClient(app);
  const response = await createAccount(admin, { name: "คูการ์", username: "cougar" });
  assert.equal(response.status, 201);
  const body = await response.json();
  const [member] = query(app.dbPath, "SELECT * FROM members WHERE username = 'cougar'");
  assert.equal(member.name, "คูการ์");
  assert.equal(member.role, "member");
  const [audit] = query(app.dbPath, "SELECT * FROM audit_log WHERE action = 'member.account_created' AND subject_id = ?", String(member.id));
  assert.equal(audit.subject_type, "account");
  assert.equal(audit.actor_name, "admin");
  const detail = JSON.parse(audit.detail);
  assert.deepEqual([detail.username, detail.name, detail.role, detail.source], ["cougar", "คูการ์", "member", "admin"]);
  assert.ok(!audit.detail.includes(body.setup_code));
});

test("case, whitespace, NFC and zero-width variants of a name are one name", async (t) => {
  const app = await startApp(t);
  const admin = await adminClient(app);
  assert.equal((await createAccount(admin, { name: "José Tiw", username: "tiw" })).status, 201);
  for (const [index, variant] of ["  jose\u0301   TIW ", "JOSÉ\u200B TIW", "josé\ttiw"].entries()) {
    const response = await createAccount(admin, { name: variant, username: "tiw" + index });
    assert.equal(response.status, 409, variant);
    assert.deepEqual(await response.json(), { detail: "name_taken" });
  }
  const members = query(app.dbPath, "SELECT * FROM members WHERE username LIKE 'tiw%'");
  assert.equal(members.length, 1);
  assert.equal(members[0].name, "José Tiw");
});

test("simultaneous creates of one username make one account", async (t) => {
  const app = await startApp(t);
  const admin = await adminClient(app);
  const responses = await Promise.all(
    Array.from({ length: 10 }, (_, i) => createAccount(admin, { name: "นาย " + i, username: i % 2 ? "NAI" : " nai " })),
  );
  const statuses = responses.map((response) => response.status).sort();
  assert.deepEqual(statuses, [201, ...Array(9).fill(409)]);
  assert.equal(query(app.dbPath, "SELECT * FROM members WHERE username = 'nai'").length, 1);
});

test("racing creates from separate threads and connections produce one row", async (t) => {
  // True parallelism: 6 worker threads, each with its own SQLite connection to
  // the same file, all resolving the same new name at once. Only the UNIQUE
  // index can make this come out as one row.
  const app = await startApp(t);
  const dbUrl = new URL("../src/db/connection.js", import.meta.url).href;
  const membersUrl = new URL("../src/members.js", import.meta.url).href;
  const source = `
    const { workerData, parentPort } = require("node:worker_threads");
    (async () => {
      const { openDb } = await import(workerData.dbUrl);
      const { parseMemberName, resolveOrCreateMember } = await import(workerData.membersUrl);
      const db = openDb(workerData.dbPath);
      Atomics.wait(new Int32Array(workerData.gate), 0, 0);
      const ids = [];
      for (let i = 0; i < 25; i += 1) {
        ids.push(resolveOrCreateMember(db, parseMemberName(workerData.name), { actorKind: "member", actorName: "race", source: "test" }).id);
      }
      db.close();
      parentPort.postMessage(ids);
    })().catch((error) => parentPort.postMessage({ error: String(error) }));
  `;
  const gate = new SharedArrayBuffer(4);
  const names = ["Racer", "racer", " RACER ", "Racer", "rAcEr", "racer"];
  const results = names.map(
    (name) =>
      new Promise((resolve, reject) => {
        const worker = new Worker(source, {
          eval: true,
          workerData: { dbUrl, membersUrl, dbPath: app.dbPath, name, gate },
        });
        worker.once("message", resolve);
        worker.once("error", reject);
      }),
  );
  // Let every worker open its connection, then release them together.
  await new Promise((resolve) => setTimeout(resolve, 300));
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0);
  const all = await Promise.all(results);
  for (const result of all) assert.ok(Array.isArray(result), JSON.stringify(result));
  const ids = new Set(all.flat());
  assert.equal(ids.size, 1, "ids " + [...ids]);
  assert.equal(query(app.dbPath, MEMBERS_SQL).length, 1, "member rows");
  const created = query(app.dbPath, "SELECT * FROM audit_log WHERE action = 'member.created'");
  assert.equal(created.length, 1, "member.created rows " + JSON.stringify(created));
});

test("the database itself refuses a second row with the same name key or username", async (t) => {
  const app = await startApp(t);
  await ensureMember(app, "ติ้ว", { username: "tiw" });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(app.dbPath);
  try {
    assert.throws(
      () => db.prepare("INSERT INTO members (name, name_key, created_at) VALUES (?, ?, ?)").run("x", "ติ้ว", "t"),
      /UNIQUE constraint failed: members\.name_key/,
    );
    assert.throws(
      () => db.prepare("INSERT INTO members (name, name_key, created_at, username) VALUES (?, ?, ?, ?)").run("y", "y", "t", "tiw"),
      /UNIQUE constraint failed: members\.username/,
    );
    assert.throws(
      () => db.prepare("INSERT INTO members (name, name_key, created_at, role) VALUES (?, ?, ?, ?)").run("z", "z", "t", "root"),
      /CHECK constraint failed/,
    );
  } finally {
    db.close();
  }
});

test("invalid names and usernames are rejected at account creation with Thai-mapped codes", async (t) => {
  const app = await startApp(t);
  const admin = await adminClient(app);
  const before = query(app.dbPath, "SELECT COUNT(*) AS n FROM members")[0].n;
  for (const [body, detail] of [
    [{ name: "", username: "valid" }, "member_name_required"],
    [{ name: "ก".repeat(61), username: "valid" }, "member_name_too_long"],
    [{ name: "bad\u0007name", username: "valid" }, "member_name_invalid"],
    [{ name: "ok", username: "ab" }, "username_invalid"],
    [{ name: "ok", username: "ติ้ว" }, "username_invalid"],
    [{ name: "ok", username: "has space" }, "username_invalid"],
    [{ name: "ok", username: "x".repeat(33) }, "username_invalid"],
    [{ name: "ok", username: "valid", role: "root" }, "invalid_role"],
  ]) {
    const response = await createAccount(admin, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await response.json(), { detail });
  }
  assert.equal(query(app.dbPath, "SELECT COUNT(*) AS n FROM members")[0].n, before);
  const { errorMessage } = await import("../public/js/copy.js");
  assert.equal(errorMessage(400, "member_name_too_long"), "ชื่อยาวเกินไป (ไม่เกิน 60 ตัวอักษร)");
  assert.match(errorMessage(400, "username_invalid"), /a–z/);
});

test("resolve and find normalize their input even when the caller did not", async (t) => {
  const app = await startApp(t);
  const { resolveOrCreateMember, findMemberByName } = await import("../src/members.js");
  const audit = { actorKind: "admin", actorName: "admin", source: "test" };
  const first = resolveOrCreateMember(app.ctx.db, "Racer", audit);
  assert.equal(resolveOrCreateMember(app.ctx.db, "  rACER ", audit).id, first.id);
  assert.equal(findMemberByName(app.ctx.db, " RACER\u200B ").id, first.id);
  assert.equal(findMemberByName(app.ctx.db, "nobody"), null);
  assert.equal(query(app.dbPath, MEMBERS_SQL).length, 1);
});
