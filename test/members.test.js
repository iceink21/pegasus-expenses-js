// Typed member names: normalization, validation, lookup-or-create, and the
// guarantee that racing creates of one name produce one row.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";

import { HttpError } from "../src/http-error.js";
import { memberNameKey, normalizeMemberName, parseMemberName } from "../src/members.js";
import { query, startApp, stubSlip, TEAM_PASSCODE, teamClient, upload } from "./helpers.js";

const MEMBERS_SQL = "SELECT * FROM members ORDER BY id";

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

test("a new name creates a member and audits member.created", async (t) => {
  const app = await startApp(t);
  await teamClient(app, "คูการ์");
  const [member] = query(app.dbPath, MEMBERS_SQL);
  assert.equal(member.name, "คูการ์");
  const [audit] = query(app.dbPath, "SELECT * FROM audit_log WHERE action = 'member.created'");
  assert.equal(audit.subject_type, "member");
  assert.equal(audit.subject_id, String(member.id));
  assert.deepEqual(JSON.parse(audit.detail), { name: "คูการ์", source: "login" });
});

test("case, whitespace, NFC and zero-width variants reuse one member id", async (t) => {
  const app = await startApp(t);
  for (const variant of ["José Tiw", "  jose\u0301   TIW ", "JOSÉ\u200B TIW", "josé\ttiw"]) {
    const team = await teamClient(app, variant);
    await upload(team, { payload: stubSlip("PEGASUS_STUB_AMOUNT=100.00", variant) });
  }
  const members = query(app.dbPath, MEMBERS_SQL);
  assert.equal(members.length, 1);
  assert.equal(members[0].name, "José Tiw", "the first spelling is kept as the display name");
  const ids = query(app.dbPath, "SELECT DISTINCT member_id FROM expenses").map((row) => row.member_id);
  assert.deepEqual(ids, [members[0].id]);
  assert.equal(query(app.dbPath, "SELECT * FROM audit_log WHERE action = 'member.created'").length, 1);
});

test("simultaneous logins with one new name create one row", async (t) => {
  const app = await startApp(t);
  const variants = ["นาย", " นาย", "นาย ", "นาย\u200B", "  นาย  "];
  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      app.client().postForm("/login", { passcode: TEAM_PASSCODE, member_name: variants[i % variants.length] }),
    ),
  );
  assert.ok(responses.every((response) => response.status === 303));
  assert.equal(query(app.dbPath, MEMBERS_SQL).length, 1);
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

test("the database itself refuses a second row with the same key", async (t) => {
  const app = await startApp(t);
  await teamClient(app, "ติ้ว");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(app.dbPath);
  try {
    assert.throws(
      () => db.prepare("INSERT INTO members (name, name_key, created_at) VALUES (?, ?, ?)").run("x", "ติ้ว", "t"),
      /UNIQUE constraint failed: members\.name_key/,
    );
  } finally {
    db.close();
  }
});

test("invalid names are rejected at login with a Thai-mapped code", async (t) => {
  const app = await startApp(t);
  for (const [name, detail] of [
    ["", "member_name_required"],
    ["ก".repeat(61), "member_name_too_long"],
    ["bad\u0007name", "member_name_invalid"],
  ]) {
    const response = await app.client().postForm("/login", { passcode: TEAM_PASSCODE, member_name: name });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { detail });
  }
  assert.equal(query(app.dbPath, MEMBERS_SQL).length, 0);
  const { errorMessage } = await import("../public/js/copy.js");
  assert.equal(errorMessage(400, "member_name_too_long"), "ชื่อยาวเกินไป (ไม่เกิน 60 ตัวอักษร)");
});

test("TEAM_MEMBERS is no longer a roster", async (t) => {
  // Setting it has no effect: any valid typed name is accepted.
  const app = await startApp(t, { TEAM_MEMBERS: "ติ้ว" });
  await teamClient(app, "คนใหม่");
  assert.deepEqual(query(app.dbPath, "SELECT name FROM members").map((row) => row.name), ["คนใหม่"]);
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
