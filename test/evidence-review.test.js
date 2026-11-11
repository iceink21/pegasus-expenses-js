// Evidence routing by server-side verdict, the admin review endpoint, the
// shared totals aggregate, and the xlsx export.
//
// Local storage is used throughout, so every routing claim is checked against
// the real file on disk, not only the row.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import ExcelJS from "exceljs";

import { routeFolder, Verdict } from "../src/decision.js";
import { memberFolderName } from "../src/storage/base.js";
import { LocalDiskStorage } from "../src/storage/local.js";
import { loadTotals } from "../src/totals.js";
import { buildTotalsWorkbook, ITEMS_SHEET, SUMMARY_SHEET, XLSX_MIME } from "../src/xlsx.js";
import { adminClient, MEMBERS, query, startApp, stubSlip, teamClient, upload } from "./helpers.js";

const expenseRow = (app, id) => query(app.dbPath, "SELECT * FROM expenses WHERE id = ?", id)[0];
const auditRows = (app, action) =>
  query(app.dbPath, "SELECT * FROM audit_log WHERE action = ? ORDER BY id", action);

/** Write to the app's database from the test (the app holds its own handle). */
function writeDb(app, sql, ...params) {
  const db = new DatabaseSync(app.dbPath);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

async function submit(client, claimed, marker, salt) {
  const { status, body } = await upload(client, { claimed, payload: stubSlip(marker, salt) });
  assert.equal(status, 200);
  return body.expense.id;
}

const review = (client, id, payload) => client.postJson("/api/admin/expenses/" + id + "/review", payload);

// New uploads live at <uploads>/<name>_M<id>/<verdict>/<file>.
function assertFileIn(app, row, folder) {
  assert.ok(fs.existsSync(row.evidence_ref), "evidence file missing: " + row.evidence_ref);
  const memberDir = memberFolderName({
    memberId: row.member_id,
    memberName: query(app.dbPath, "SELECT name FROM members WHERE id = ?", row.member_id)[0].name,
  });
  assert.equal(path.dirname(row.evidence_ref), path.join(path.resolve(app.uploadDir), memberDir, folder));
  assert.equal(row.evidence_folder, folder);
}

// Legacy rows keep the flat <uploads>/<verdict>/<file> layout after a review.
function assertFlatFileIn(app, row, folder) {
  assert.ok(fs.existsSync(row.evidence_ref), "evidence file missing: " + row.evidence_ref);
  assert.equal(path.dirname(row.evidence_ref), path.join(path.resolve(app.uploadDir), folder));
  assert.equal(row.evidence_folder, folder);
}

// --- routing -----------------------------------------------------------------

test("routeFolder: only a clean MATCH is verified", () => {
  assert.equal(routeFolder(Verdict.MATCH, 0), "verified");
  assert.equal(routeFolder(Verdict.MATCH, 1), "needs-review");
  assert.equal(routeFolder(Verdict.MISMATCH, 1), "needs-review");
  assert.equal(routeFolder(Verdict.MISMATCH, 0), "needs-review");
  assert.equal(routeFolder(Verdict.UNREADABLE, 0), "needs-review");
  assert.equal(routeFolder("anything else", 0), "needs-review");
});

const ROUTING_CASES = [
  { name: "MATCH clean", claimed: "100.00", marker: "PEGASUS_STUB_AMOUNT=100.00", dup: false, folder: "verified", status: "verified", flag: null },
  { name: "MATCH + duplicate", claimed: "100.00", marker: "PEGASUS_STUB_AMOUNT=100.00", dup: true, folder: "needs-review", status: "pending", flag: "duplicate_image" },
  { name: "MISMATCH", claimed: "100.00", marker: "PEGASUS_STUB_AMOUNT=55.00", dup: false, folder: "needs-review", status: "pending", flag: "amount_mismatch" },
  { name: "MISMATCH + duplicate", claimed: "100.00", marker: "PEGASUS_STUB_AMOUNT=55.00", dup: true, folder: "needs-review", status: "pending", flag: "amount_mismatch,duplicate_image" },
  { name: "UNREADABLE", claimed: "100.00", marker: "PEGASUS_STUB_UNREADABLE", dup: false, folder: "needs-review", status: "pending", flag: null },
];

for (const scenario of ROUTING_CASES) {
  test("routing: " + scenario.name + " → " + scenario.folder, async (t) => {
    const app = await startApp(t);
    const team = await teamClient(app);
    const [member] = query(app.dbPath, "SELECT id FROM members WHERE name = ?", MEMBERS[0]);
    let originalId = null;
    if (scenario.dup) originalId = await submit(team, scenario.claimed, scenario.marker, "same");
    const id = await submit(team, scenario.claimed, scenario.marker, "same");

    const row = expenseRow(app, id);
    assert.equal(row.flag_reason, scenario.flag);
    assert.equal(row.review_status, scenario.status);
    assertFileIn(app, row, scenario.folder);
    assert.match(path.basename(row.evidence_ref), new RegExp("^M" + member.id + "_\\d{8}T\\d{6}_[0-9a-f]{8}_slip\\.jpg$"));

    if (scenario.dup) {
      const original = expenseRow(app, originalId);
      assert.equal(row.duplicate_of_id, originalId);
      assert.notEqual(row.evidence_ref, original.evidence_ref, "a duplicate gets its own file");
      assert.ok(fs.existsSync(original.evidence_ref));
      assert.deepEqual(fs.readFileSync(row.evidence_ref), fs.readFileSync(original.evidence_ref));
      assert.ok(
        query(app.dbPath, "SELECT * FROM audit_log WHERE action = 'expense.duplicate_hash' AND subject_id = ?", String(id)).length === 1,
      );
    }
    const decision = query(
      app.dbPath,
      "SELECT detail FROM audit_log WHERE subject_id = ? AND action LIKE 'expense.decision.%'",
      String(id),
    );
    assert.equal(decision.length, 1);
    assert.equal(JSON.parse(decision[0].detail).evidence_folder, scenario.folder);
  });
}

test("request fields cannot steer a file into verified", async (t) => {
  const app = await startApp(t);
  const team = await teamClient(app);
  const { body } = await upload(team, {
    claimed: "100.00",
    payload: stubSlip("PEGASUS_STUB_AMOUNT=10.00", "steer"),
    filename: "../../verified/x.jpg",
    extra: { folder: "verified", evidence_folder: "verified", review_status: "verified" },
  });
  const row = expenseRow(app, body.expense.id);
  assertFileIn(app, row, "needs-review");
  assert.equal(row.review_status, "pending");
});

test("LocalDiskStorage.move refuses refs outside the upload directory", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pegasus-move-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const storage = new LocalDiskStorage(path.join(dir, "uploads"));
  const outside = path.join(dir, "secret.txt");
  fs.writeFileSync(outside, "keep me");
  await assert.rejects(storage.move(outside, "verified"), /outside the upload directory/);
  await assert.rejects(storage.move(path.join(dir, "uploads", "..", "secret.txt"), "verified"), /outside/);
  // A routed folder itself sits "in the root" by path; it must not be movable.
  await assert.rejects(storage.move(path.join(dir, "uploads", "verified"), "rejected"), /not a regular file/);
  assert.ok(fs.statSync(path.join(dir, "uploads", "verified")).isDirectory());
  // A symlink inside the upload dir pointing outside is refused too.
  const link = path.join(dir, "uploads", "needs-review", "link.jpg");
  fs.symlinkSync(outside, link);
  await assert.rejects(storage.move(link, "verified"), /not a regular file/);
  await assert.rejects(storage.move(path.join(dir, "uploads", "a", "b", "c.jpg"), "verified"), /known folder/);
  assert.equal(fs.readFileSync(outside, "utf8"), "keep me");
  const stored = await storage.store({ data: Buffer.from("x"), filename: "a.jpg", contentType: "image/jpeg", folder: "needs-review" });
  await assert.rejects(storage.move(stored.ref, "../escape"), /unknown evidence folder/);
  const moved = await storage.move(stored.ref, "rejected");
  assert.ok(fs.existsSync(moved.ref) && !fs.existsSync(stored.ref));
});

// --- review endpoint ------------------------------------------------------

test("approve with a corrected amount: file moves, audit has claimed vs approved, claim/verdict untouched", async (t) => {
  const app = await startApp(t);
  const team = await teamClient(app);
  const id = await submit(team, "1250.00", "PEGASUS_STUB_AMOUNT=980.00", "approve");
  const before = expenseRow(app, id);
  assertFileIn(app, before, "needs-review");

  const admin = await adminClient(app);
  const response = await review(admin, id, { decision: "approve", approved_amount: "980.00", note: "  ใบเสร็จจริง 980  " });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.detail_level, "admin");
  assert.equal(body.expense.review_status, "approved");
  assert.equal(body.expense.approved_amount, 980);

  const row = expenseRow(app, id);
  assert.equal(row.claimed_amount, 1250, "claimed_amount is never rewritten");
  assert.equal(row.verdict, "MISMATCH", "verdict is never rewritten");
  assert.equal(row.flag_reason, "amount_mismatch");
  assert.equal(row.approved_amount, 980);
  assert.equal(row.reviewed_by, "admin");
  assert.match(row.reviewed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
  assert.equal(row.review_note, "ใบเสร็จจริง 980");
  assertFileIn(app, row, "verified");
  assert.ok(!fs.existsSync(before.evidence_ref), "the old path is gone");
  assert.equal(path.basename(row.evidence_ref), path.basename(before.evidence_ref));

  const [audit] = auditRows(app, "expense.review.approved");
  assert.equal(audit.subject_id, String(id));
  assert.equal(audit.outcome, "approved");
  assert.deepEqual(JSON.parse(audit.detail), {
    approved_amount: 980,
    claimed_amount: 1250,
    copied_shared_evidence: false,
    from_folder: "needs-review",
    member: MEMBERS[0],
    member_id: row.member_id,
    note: "ใบเสร็จจริง 980",
    shared_with_ids: [],
    to_folder: "verified",
    verdict: "MISMATCH",
  });
});

test("approve without, or with an invalid, approved_amount is a 400 and changes nothing", async (t) => {
  const app = await startApp(t);
  const id = await submit(await teamClient(app), "100.00", "PEGASUS_STUB_UNREADABLE", "bad-amount");
  const before = expenseRow(app, id);
  const admin = await adminClient(app);
  for (const [payload, detail] of [
    [{ decision: "approve" }, "amount_required"],
    [{ decision: "approve", approved_amount: "" }, "amount_required"],
    [{ decision: "approve", approved_amount: "abc" }, "amount_not_a_number"],
    [{ decision: "approve", approved_amount: [5] }, "amount_not_a_number"],
    [{ decision: "approve", approved_amount: true }, "amount_not_a_number"],
    [{ decision: "approve", approved_amount: 0 }, "amount_must_be_positive"],
    [{ decision: "approve", approved_amount: "-5" }, "amount_must_be_positive"],
    [{ decision: "approve", approved_amount: 10_000_000.01 }, "amount_out_of_range"],
    [{ decision: "maybe" }, "invalid_decision"],
    [{}, "invalid_decision"],
    [{ decision: "reject", note: 5 }, "invalid_note"],
    [{ decision: "reject", note: "ก".repeat(501) }, "note_too_long"],
  ]) {
    const response = await review(admin, id, payload);
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.equal((await response.json()).detail, detail, JSON.stringify(payload));
  }
  // Not JSON at all.
  const raw = await admin.request("POST", "/api/admin/expenses/" + id + "/review", {
    body: "decision=approve",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
  });
  assert.equal(raw.status, 400);
  const malformed = await admin.request("POST", "/api/admin/expenses/" + id + "/review", {
    body: "{not json",
    headers: { "content-type": "application/json", accept: "application/json" },
  });
  assert.equal(malformed.status, 400);

  assert.deepEqual(expenseRow(app, id), before);
  assert.ok(fs.existsSync(before.evidence_ref));
  assert.equal(auditRows(app, "expense.review.approved").length, 0);

  // Thai digits and separators parse like the upload form, and 500 chars is fine.
  const ok = await review(admin, id, { decision: "approve", approved_amount: "๑,๒๕๐.๕๐ ฿", note: "ก".repeat(500) });
  assert.equal(ok.status, 200);
  assert.equal(expenseRow(app, id).approved_amount, 1250.5);
});

test("reject: file goes to rejected, approved_amount stays null, claim leaves the claimed total", async (t) => {
  const app = await startApp(t);
  const team = await teamClient(app);
  await submit(team, "100.00", "PEGASUS_STUB_AMOUNT=100.00", "keep");
  const id = await submit(team, "70.00", "PEGASUS_STUB_AMOUNT=7.00", "reject");
  const admin = await adminClient(app);

  const response = await review(admin, id, { decision: "reject", approved_amount: "70", note: "ไม่ใช่ค่าใช้จ่ายทีม" });
  assert.equal(response.status, 200);
  const row = expenseRow(app, id);
  assert.equal(row.review_status, "rejected");
  assert.equal(row.approved_amount, null, "approved_amount is ignored on reject");
  assert.equal(row.claimed_amount, 70);
  assert.equal(row.verdict, "MISMATCH");
  assertFileIn(app, row, "rejected");
  const [audit] = auditRows(app, "expense.review.rejected");
  assert.equal(JSON.parse(audit.detail).to_folder, "rejected");
  assert.equal(JSON.parse(audit.detail).approved_amount, null);

  const dashboard = await (await admin.get("/api/admin/dashboard")).json();
  assert.equal(dashboard.grand.claimed_total, 100);
  assert.equal(dashboard.grand.rejected_total, 70);
  assert.equal(dashboard.grand_total, 100);
  assert.equal(dashboard.totals.find((entry) => entry.member_name === MEMBERS[0]).claimed_total, 100);
});

test("only pending rows are reviewable (409 not_pending); bad ids are 422/404", async (t) => {
  const app = await startApp(t);
  const team = await teamClient(app);
  const verifiedId = await submit(team, "100.00", "PEGASUS_STUB_AMOUNT=100.00", "v");
  const pendingId = await submit(team, "100.00", "PEGASUS_STUB_AMOUNT=1.00", "p");
  const admin = await adminClient(app);

  let response = await review(admin, verifiedId, { decision: "reject" });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).detail, "not_pending");
  assertFileIn(app, expenseRow(app, verifiedId), "verified");

  assert.equal((await review(admin, pendingId, { decision: "reject" })).status, 200);
  response = await review(admin, pendingId, { decision: "approve", approved_amount: "1" });
  assert.equal(response.status, 409);
  assertFileIn(app, expenseRow(app, pendingId), "rejected");

  assert.equal((await review(admin, "abc", { decision: "reject" })).status, 422);
  assert.equal((await review(admin, 9999, { decision: "reject" })).status, 404);
});

test("two simultaneous reviews of one row: exactly one wins", async (t) => {
  const app = await startApp(t);
  const id = await submit(await teamClient(app), "100.00", "PEGASUS_STUB_AMOUNT=1.00", "race");
  const admin = await adminClient(app);
  const responses = await Promise.all([
    review(admin, id, { decision: "approve", approved_amount: "1" }),
    review(admin, id, { decision: "reject" }),
    review(admin, id, { decision: "reject" }),
  ]);
  const statuses = responses.map((response) => response.status).sort();
  assert.deepEqual(statuses, [200, 409, 409]);
  const row = expenseRow(app, id);
  assertFileIn(app, row, row.review_status === "approved" ? "verified" : "rejected");
  const decided = [...auditRows(app, "expense.review.approved"), ...auditRows(app, "expense.review.rejected")];
  assert.equal(decided.length, 1);
});

test("a failed move is audited at the point of failure, leaves the row pending, and returns 502", async (t) => {
  const app = await startApp(t);
  const id = await submit(await teamClient(app), "100.00", "PEGASUS_STUB_AMOUNT=1.00", "move-fail");
  // A tampered ref pointing outside the upload directory.
  writeDb(app, "UPDATE expenses SET evidence_ref = ? WHERE id = ?", "/etc/hosts", id);
  const admin = await adminClient(app);
  const response = await review(admin, id, { decision: "approve", approved_amount: "1" });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).detail, "evidence_move_failed");
  const row = expenseRow(app, id);
  assert.equal(row.review_status, "pending");
  assert.equal(row.approved_amount, null);
  const [failed] = auditRows(app, "expense.review.move_failed");
  assert.equal(failed.subject_id, String(id));
  const detail = JSON.parse(failed.detail);
  assert.equal(detail.to_folder, "verified");
  assert.match(detail.error, /outside the upload directory/);
  assert.equal(auditRows(app, "expense.review.approved").length, 0);
});

test("a legacy local file in the upload root is moved by a review", async (t) => {
  const app = await startApp(t);
  const id = await submit(await teamClient(app), "100.00", "PEGASUS_STUB_AMOUNT=1.00", "legacy");
  const legacyPath = path.join(path.resolve(app.uploadDir), "20261001T000000_abcdef12_old.jpg");
  fs.writeFileSync(legacyPath, "old slip");
  writeDb(app, "UPDATE expenses SET evidence_ref = ?, evidence_folder = 'legacy' WHERE id = ?", legacyPath, id);
  const admin = await adminClient(app);
  assert.equal((await review(admin, id, { decision: "approve", approved_amount: "1" })).status, 200);
  const row = expenseRow(app, id);
  assertFlatFileIn(app, row, "verified");
  assert.equal(fs.readFileSync(row.evidence_ref, "utf8"), "old slip");
  assert.equal(JSON.parse(auditRows(app, "expense.review.approved")[0].detail).from_folder, "legacy");
});

test("a member session is refused on the review endpoint and the xlsx export, and both are audited", async (t) => {
  const app = await startApp(t);
  const team = await teamClient(app);
  const id = await submit(team, "100.00", "PEGASUS_STUB_AMOUNT=1.00", "member-deny");
  const before = expenseRow(app, id);

  // Logged in, but not an admin: 403, not "go log in".
  const response = await review(team, id, { decision: "approve", approved_amount: "1" });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { detail: "admin_required" });
  assert.deepEqual(expenseRow(app, id), before);

  const xlsx = await team.get("/admin/totals.xlsx");
  assert.equal(xlsx.status, 303);
  assert.equal(xlsx.headers.get("location"), "/upload");

  const denials = query(app.dbPath, "SELECT * FROM audit_log WHERE action = 'access.denied' ORDER BY id");
  assert.deepEqual(
    denials.map((row) => [row.actor_kind, row.actor_name, row.subject_id, JSON.parse(row.detail).reason]),
    [
      ["member", MEMBERS[0], "POST /api/admin/expenses/" + id + "/review", "not_admin"],
      ["member", MEMBERS[0], "GET /admin/totals.xlsx", "not_admin"],
    ],
  );
  // Anonymous too.
  assert.equal((await review(app.client(), id, { decision: "reject" })).status, 401);
});

test("the member views never carry review fields, before or after a review", async (t) => {
  const app = await startApp(t);
  const team = await teamClient(app);
  const id = await submit(team, "100.00", "PEGASUS_STUB_AMOUNT=1.00", "privacy");
  const admin = await adminClient(app);
  assert.equal((await review(admin, id, { decision: "approve", approved_amount: "1", note: "ok" })).status, 200);
  const reviewKeys = ["review_status", "evidence_folder", "approved_amount", "reviewed_by", "reviewed_at", "review_note"];
  for (const urlPath of ["/api/expenses/" + id, "/api/my"]) {
    const text = await (await team.get(urlPath)).text();
    for (const key of reviewKeys) assert.ok(!text.includes(key), urlPath + " leaks " + key);
    assert.ok(!/approved|rejected|pending|verified|needs-review/.test(text), urlPath + " leaks review state: " + text);
  }
});

// --- legacy rows sharing one file, conflicts, failed transactions ----------

/** QC's scenario: A (verified, legacy) and its duplicate B (pending, legacy) share one file. */
async function legacySharedPair(app) {
  const team = await teamClient(app);
  const a = await submit(team, "100.00", "PEGASUS_STUB_AMOUNT=100.00", "orig");
  const b = await submit(team, "100.00", "PEGASUS_STUB_AMOUNT=1.00", "dup");
  const shared = path.join(path.resolve(app.uploadDir), "20261001T000000_abcdef12_shared.jpg");
  fs.writeFileSync(shared, "genuine slip");
  writeDb(app, "UPDATE expenses SET evidence_ref = ?, evidence_folder = 'legacy', review_status = 'verified', flagged = 0 WHERE id = ?", shared, a);
  writeDb(app, "UPDATE expenses SET evidence_ref = ?, evidence_folder = 'legacy', review_status = 'pending', duplicate_of_id = ? WHERE id = ?", shared, a, b);
  return { a, b, shared };
}

for (const decision of ["reject", "approve"]) {
  test("legacy duplicate sharing its original's file: " + decision + " copies, the original is untouched", async (t) => {
    const app = await startApp(t);
    const { a, b, shared } = await legacySharedPair(app);
    const admin = await adminClient(app);
    const payload = decision === "approve" ? { decision, approved_amount: "1" } : { decision };
    assert.equal((await review(admin, b, payload)).status, 200);

    const original = expenseRow(app, a);
    assert.equal(original.evidence_ref, shared, "the original's ref is unchanged");
    assert.equal(original.evidence_folder, "legacy");
    assert.equal(original.review_status, "verified");
    assert.equal(fs.readFileSync(shared, "utf8"), "genuine slip", "the original's file is still there");

    const dup = expenseRow(app, b);
    const folder = decision === "approve" ? "verified" : "rejected";
    assertFileIn(app, dup, folder);
    assert.notEqual(dup.evidence_ref, shared);
    assert.equal(fs.readFileSync(dup.evidence_ref, "utf8"), "genuine slip");
    assert.match(path.basename(dup.evidence_ref), new RegExp("^M" + dup.member_id + "_\\d{8}T\\d{6}_[0-9a-f]{8}_"));

    const [audit] = auditRows(app, "expense.review." + (decision === "approve" ? "approved" : "rejected"));
    const detail = JSON.parse(audit.detail);
    assert.equal(detail.copied_shared_evidence, true);
    assert.deepEqual(detail.shared_with_ids, [a]);
  });
}

test("a lost race after the file move is audited as a conflict and the move is undone", async (t) => {
  const app = await startApp(t);
  const id = await submit(await teamClient(app), "100.00", "PEGASUS_STUB_AMOUNT=1.00", "conflict");
  const before = expenseRow(app, id);
  const storage = app.ctx.providers.storage;
  const realMove = storage.move.bind(storage);
  // Another process reviews the row while our file move is in flight.
  storage.move = async (ref, folder) => {
    const result = await realMove(ref, folder);
    if (folder === "verified") {
      writeDb(app, "UPDATE expenses SET review_status = 'rejected', evidence_folder = 'needs-review' WHERE id = ?", id);
    }
    return result;
  };
  t.after(() => { storage.move = realMove; });

  const admin = await adminClient(app);
  const response = await review(admin, id, { decision: "approve", approved_amount: "1" });
  assert.equal(response.status, 409);
  assert.ok(fs.existsSync(before.evidence_ref), "the file is back where the committed row says");
  const [conflict] = auditRows(app, "expense.review.conflict");
  const detail = JSON.parse(conflict.detail);
  assert.deepEqual([detail.undo, detail.undo_ok, detail.committed_status], ["moved_back", true, "rejected"]);
  assert.equal(auditRows(app, "expense.review.approved").length, 0);
});

test("a failed transaction undoes the move, is audited, and the row can still be reviewed", async (t) => {
  const app = await startApp(t);
  const id = await submit(await teamClient(app), "100.00", "PEGASUS_STUB_AMOUNT=1.00", "txfail");
  const before = expenseRow(app, id);
  writeDb(app, "CREATE TRIGGER fail_review BEFORE UPDATE OF review_status ON expenses BEGIN SELECT RAISE(ABORT, 'boom'); END");
  const admin = await adminClient(app);
  const response = await review(admin, id, { decision: "reject" });
  assert.equal(response.status, 500);
  assert.deepEqual(expenseRow(app, id), before, "the row is unchanged");
  assert.ok(fs.existsSync(before.evidence_ref), "the file was moved back to the stored ref");
  const [failed] = auditRows(app, "expense.review.tx_failed");
  const detail = JSON.parse(failed.detail);
  assert.deepEqual([detail.undo, detail.undo_ok, detail.to_folder], ["moved_back", true, "rejected"]);
  assert.match(detail.error, /boom/);

  writeDb(app, "DROP TRIGGER fail_review");
  assert.equal((await review(admin, id, { decision: "reject" })).status, 200, "no permanent 502");
  assertFileIn(app, expenseRow(app, id), "rejected");
});

test("a failed transaction on a shared legacy file deletes the copy, never the original", async (t) => {
  const app = await startApp(t);
  const { b, shared } = await legacySharedPair(app);
  writeDb(app, "CREATE TRIGGER fail_review BEFORE UPDATE OF review_status ON expenses BEGIN SELECT RAISE(ABORT, 'boom'); END");
  const admin = await adminClient(app);
  assert.equal((await review(admin, b, { decision: "reject" })).status, 500);
  assert.equal(fs.readFileSync(shared, "utf8"), "genuine slip");
  assert.deepEqual(fs.readdirSync(path.join(path.resolve(app.uploadDir), "rejected")), [], "no flat copy was made");
  const memberDir = memberFolderName({
    memberId: expenseRow(app, b).member_id,
    memberName: query(app.dbPath, "SELECT name FROM members WHERE id = ?", expenseRow(app, b).member_id)[0].name,
  });
  assert.deepEqual(fs.readdirSync(path.join(path.resolve(app.uploadDir), memberDir, "rejected")), [], "the copy was removed");
  const detail = JSON.parse(auditRows(app, "expense.review.tx_failed")[0].detail);
  assert.deepEqual([detail.undo, detail.undo_ok, detail.copied_shared_evidence], ["removed_copy", true, true]);
});

test("totals never drop a row with a NULL review_status, and empty members count zero", async (t) => {
  const app = await startApp(t);
  const team = await teamClient(app);
  await teamClient(app, MEMBERS[1]);
  const id = await submit(team, "40.00", "PEGASUS_STUB_AMOUNT=40.00", "null-status");
  writeDb(app, "UPDATE expenses SET review_status = NULL WHERE id = ?", id);
  const { members, grand } = loadTotals(app.ctx.db);
  const byName = Object.fromEntries(members.map((member) => [member.member_name, member]));
  assert.deepEqual([grand.claimed_total, grand.pending_total, grand.pending_count], [40, 40, 1]);
  assert.deepEqual([byName[MEMBERS[0]].pending_count, byName[MEMBERS[0]].claimed_total], [1, 40]);
  assert.deepEqual([byName[MEMBERS[1]].n, byName[MEMBERS[1]].pending_count, byName[MEMBERS[1]].rejected_count], [0, 0, 0]);
});

// --- totals + xlsx -------------------------------------------------------------

async function seedTotals(app) {
  const first = await teamClient(app, MEMBERS[0]);
  const second = await teamClient(app, MEMBERS[1]);
  await teamClient(app, MEMBERS[2]); // a member with no expenses
  await submit(first, "100.00", "PEGASUS_STUB_AMOUNT=100.00", "a"); // verified 100
  const corrected = await submit(first, "200.00", "PEGASUS_STUB_AMOUNT=150.00", "b"); // → approved 150
  await submit(first, "50.00", "PEGASUS_STUB_UNREADABLE", "c"); // pending 50
  const rejected = await submit(first, "70.00", "PEGASUS_STUB_AMOUNT=7.00", "d"); // → rejected 70
  await submit(second, "30.10", "PEGASUS_STUB_AMOUNT=30.10", "e"); // verified 30.10
  await submit(second, "0.20", "PEGASUS_STUB_AMOUNT=0.20", "f"); // verified 0.20 (float-sum check)
  const admin = await adminClient(app);
  assert.equal((await review(admin, corrected, { decision: "approve", approved_amount: "150" })).status, 200);
  assert.equal((await review(admin, rejected, { decision: "reject" })).status, 200);
  return admin;
}

test("totals: verified = auto-verified claims + approved_amount; rejected excluded from claimed", async (t) => {
  const app = await startApp(t);
  const admin = await seedTotals(app);
  const { members, grand } = loadTotals(app.ctx.db);
  const byName = Object.fromEntries(members.map((member) => [member.member_name, member]));

  const pick = (entry) => [entry.n, entry.claimed_total, entry.verified_total, entry.pending_total,
    entry.pending_count, entry.rejected_total, entry.rejected_count];
  assert.deepEqual(pick(byName[MEMBERS[0]]), [4, 350, 250, 50, 1, 70, 1]);
  assert.deepEqual(pick(byName[MEMBERS[1]]), [2, 30.3, 30.3, 0, 0, 0, 0]);
  assert.deepEqual(pick(byName[MEMBERS[2]]), [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(byName[MEMBERS[2]].last_upload, null);
  assert.deepEqual(pick(grand), [6, 380.3, 280.3, 50, 1, 70, 1]);
  assert.equal(grand.last_upload, byName[MEMBERS[1]].last_upload);

  const dashboard = await (await admin.get("/api/admin/dashboard")).json();
  assert.deepEqual(dashboard.totals, members);
  assert.deepEqual(dashboard.grand, grand);
  assert.equal(dashboard.grand_total, 380.3);
  assert.equal(byName[MEMBERS[0]].total, 350, "legacy key kept");
});

test("GET /admin/totals.xlsx parses back and its totals equal the SQL aggregate", async (t) => {
  const app = await startApp(t);
  const admin = await seedTotals(app);
  const response = await admin.get("/admin/totals.xlsx");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), XLSX_MIME);
  assert.equal(response.headers.get("content-disposition"), "attachment; filename=\"pegasus_totals.xlsx\"");

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [SUMMARY_SHEET, ITEMS_SHEET]);

  const { members, grand } = loadTotals(app.ctx.db);
  const summary = workbook.getWorksheet(SUMMARY_SHEET);
  assert.equal(summary.rowCount, members.length + 2);
  const header = summary.getRow(1);
  assert.equal(header.getCell(1).value, "สมาชิก");
  assert.equal(header.getCell(1).font.bold, true);
  assert.equal(header.getCell(1).font.name, "Tahoma");
  members.forEach((member, index) => {
    const row = summary.getRow(index + 2);
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 7].map((column) => row.getCell(column).value),
      [member.member_name, member.n, member.claimed_total, member.verified_total,
        member.pending_total, member.rejected_total, member.pending_count],
    );
    assert.equal(row.getCell(3).numFmt, "#,##0.00");
  });
  const totalRow = summary.getRow(members.length + 2);
  assert.equal(totalRow.getCell(1).value, "รวมทั้งทีม");
  assert.equal(totalRow.getCell(4).value.formula, "SUM(D2:D" + (members.length + 1) + ")");
  assert.deepEqual(
    [2, 3, 4, 5, 6, 7].map((column) => totalRow.getCell(column).value.result),
    [grand.n, grand.claimed_total, grand.verified_total, grand.pending_total, grand.rejected_total, grand.pending_count],
  );
  // The formulas, evaluated here, agree with SQL.
  for (const [column, key] of [[3, "claimed_total"], [4, "verified_total"], [5, "pending_total"], [6, "rejected_total"]]) {
    let sum = 0;
    for (let rowNumber = 2; rowNumber <= members.length + 1; rowNumber += 1) sum += summary.getRow(rowNumber).getCell(column).value;
    assert.equal(Math.round(sum * 100) / 100, grand[key], key);
  }

  const items = workbook.getWorksheet(ITEMS_SHEET);
  const headers = items.getRow(1).values.slice(1);
  assert.ok(headers.includes("ยอดที่อนุมัติ") && headers.includes("สถานะตรวจ") && headers.includes("หลักฐาน"));
  assert.equal(items.rowCount, 1 + grand.n);
  const approvedColumn = headers.indexOf("ยอดที่อนุมัติ") + 1;
  const statusColumn = headers.indexOf("สถานะตรวจ") + 1;
  const approvedRows = [];
  items.eachRow((row, number) => {
    if (number > 1 && row.getCell(statusColumn).value === "approved") approvedRows.push(row.getCell(approvedColumn).value);
  });
  assert.deepEqual(approvedRows, [150]);

  const [audit] = query(app.dbPath, "SELECT * FROM audit_log WHERE action = 'admin.export_xlsx'");
  // Three members plus the admin, who is a member like anyone else.
  assert.deepEqual(JSON.parse(audit.detail), { members: 4, rows: 6 });
});

test("xlsx evidence column: https URLs become hyperlinks, anything else stays text; '=' text is not a formula", async () => {
  const totals = { members: [], grand: { n: 0, claimed_total: 0, verified_total: 0, pending_total: 0, rejected_total: 0, pending_count: 0, last_upload: null } };
  const base = { claimed_amount: 1, review_status: "pending", evidence_ref: "id" };
  const buffer = await buildTotalsWorkbook({
    totals,
    expenses: [
      { ...base, id: 1, evidence_url: "https://drive.google.com/file/d/abc", note: "=HYPERLINK(\"http://x\")" },
      { ...base, id: 2, evidence_url: "javascript:alert(1)" },
      { ...base, id: 3, evidence_url: null, evidence_ref: "/data/uploads/verified/a.jpg" },
    ],
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const items = workbook.getWorksheet(ITEMS_SHEET);
  const evidenceColumn = items.getRow(1).values.indexOf("หลักฐาน");
  assert.equal(items.getRow(2).getCell(evidenceColumn).hyperlink, "https://drive.google.com/file/d/abc");
  assert.equal(items.getRow(3).getCell(evidenceColumn).hyperlink, undefined);
  assert.equal(items.getRow(3).getCell(evidenceColumn).value, "id");
  assert.equal(items.getRow(4).getCell(evidenceColumn).value, "/data/uploads/verified/a.jpg");
  const noteColumn = items.getRow(1).values.indexOf("บันทึก");
  assert.equal(items.getRow(2).getCell(noteColumn).value, "=HYPERLINK(\"http://x\")");
  assert.equal(items.getRow(2).getCell(noteColumn).formula, undefined);
  // An empty team still gets a total row (plain values, no SUM over nothing).
  assert.equal(workbook.getWorksheet(SUMMARY_SHEET).getRow(2).getCell(2).value, 0);
});

test("CSV export carries the review columns", async (t) => {
  const app = await startApp(t);
  const admin = await seedTotals(app);
  const csv = await (await admin.get("/admin/export.csv")).text();
  const [header] = csv.replace(/^﻿/, "").split("\r\n");
  assert.ok(header.endsWith(",member_id,review_status,evidence_folder,approved_amount,reviewed_by,reviewed_at,review_note"));
  assert.match(csv, /,approved,verified,150,admin,/);
});
