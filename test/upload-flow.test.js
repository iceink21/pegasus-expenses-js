// Port of tests/test_upload_flow.py — end-to-end verdict paths, each asserting
// BOTH the expense row and the audit row. The audit assertions are the point:
// a decision that is not logged at the moment it is made is the failure mode
// this app was built to avoid.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

import { VERDICT_UI } from "../public/js/copy.js";
import { MEMBERS, query, startApp, stubSlip, teamClient, upload } from "./helpers.js";

const EXPENSES_ORDERED = "SELECT * FROM expenses ORDER BY id";
const AUDIT_FOR_EXPENSE =
  "SELECT * FROM audit_log WHERE subject_type = ? AND subject_id = ? ORDER BY id";

function lastExpense(dbPath) {
  const rows = query(dbPath, EXPENSES_ORDERED);
  assert.ok(rows.length > 0, "no expense row was written");
  return rows.at(-1);
}

const auditFor = (dbPath, expenseId) => query(dbPath, AUDIT_FOR_EXPENSE, "expense", String(expenseId));

test("MATCH path", async (t) => {
  const app = await startApp(t);
  const team = await teamClient(app);
  const { status, body } = await upload(team, {
    claimed: "1250.00",
    payload: stubSlip("PEGASUS_STUB_AMOUNT=1250.00"),
  });
  assert.equal(status, 200);
  assert.equal(body.decision.verdict, "MATCH");

  const row = lastExpense(app.dbPath);
  assert.equal(row.verdict, "MATCH");
  assert.equal(row.flagged, 0);
  assert.equal(row.flag_reason, null);
  assert.equal(row.extracted_amount, 1250.0);
  assert.ok(auditFor(app.dbPath, row.id).some((entry) => entry.action === "expense.decision.match"));
});

test("MATCH within epsilon", async (t) => {
  // 0.50 THB off is inside the default 1 THB tolerance.
  const app = await startApp(t);
  const team = await teamClient(app);
  const { status } = await upload(team, {
    claimed: "200.00",
    payload: stubSlip("PEGASUS_STUB_AMOUNT=200.50"),
  });
  assert.equal(status, 200);
  assert.equal(lastExpense(app.dbPath).verdict, "MATCH");
});

test("MISMATCH path flags the row and writes the audit row", async (t) => {
  const app = await startApp(t);
  const team = await teamClient(app);
  const { status, body } = await upload(team, {
    claimed: "1250.00",
    payload: stubSlip("PEGASUS_STUB_AMOUNT=980.00"),
  });
  assert.equal(status, 200);
  assert.equal(body.decision.verdict, "MISMATCH");
  assert.equal(body.decision.difference, 270);
  // The result page shows this headline for the verdict the server returned.
  assert.equal(VERDICT_UI[body.decision.verdict].headline, "ยอดที่กรอกไม่ตรงกับสลิป");

  const row = lastExpense(app.dbPath);
  assert.equal(row.verdict, "MISMATCH");
  assert.equal(row.flagged, 1);
  assert.equal(row.flag_reason, "amount_mismatch");
  assert.equal(row.claimed_amount, 1250.0);
  assert.equal(row.extracted_amount, 980.0);

  const mismatch = auditFor(app.dbPath, row.id).filter(
    (entry) => entry.action === "expense.decision.mismatch",
  );
  assert.equal(mismatch.length, 1, "the MISMATCH decision was not audited");
  assert.equal(mismatch[0].outcome, "MISMATCH");
  assert.ok(mismatch[0].detail.includes("1250") && mismatch[0].detail.includes("980"));
  assert.equal(mismatch[0].actor_name, MEMBERS[0]);
});

test("UNREADABLE path is audited but not flagged", async (t) => {
  const app = await startApp(t);
  const team = await teamClient(app);
  const { status, body } = await upload(team, {
    claimed: "500.00",
    payload: stubSlip("PEGASUS_STUB_UNREADABLE"),
  });
  assert.equal(status, 200);
  // Softer copy: ask for a retake, never imply fraud.
  const ui = VERDICT_UI[body.decision.verdict];
  assert.ok(ui.message.includes("ถ่ายใหม่"));
  assert.notEqual(ui.headline, "ยอดที่กรอกไม่ตรงกับสลิป");
  assert.equal(ui.tone, "info");

  const row = lastExpense(app.dbPath);
  assert.equal(row.verdict, "UNREADABLE");
  assert.equal(row.flagged, 0, "UNREADABLE must never be stored as a flag");
  assert.equal(row.flag_reason, null);
  assert.equal(row.extracted_amount, null);
  assert.ok(
    auditFor(app.dbPath, row.id).some((entry) => entry.action === "expense.decision.unreadable"),
  );
});

test("duplicate hash flags the row, reuses the evidence and writes the audit row", async (t) => {
  const app = await startApp(t);
  const team = await teamClient(app);
  const payload = stubSlip("PEGASUS_STUB_AMOUNT=310.50", "dup");

  assert.equal((await upload(team, { claimed: "310.50", payload })).status, 200);
  const original = lastExpense(app.dbPath);
  assert.equal(original.duplicate_of_id, null);
  assert.equal(original.flagged, 0);

  const second = await upload(team, { claimed: "310.50", payload });
  assert.equal(second.status, 200);
  assert.equal(second.body.decision.is_duplicate, true);

  const row = lastExpense(app.dbPath);
  assert.notEqual(row.id, original.id);
  assert.equal(row.image_sha256, original.image_sha256);
  assert.equal(row.duplicate_of_id, original.id);
  assert.equal(row.evidence_ref, original.evidence_ref);
  assert.equal(row.flagged, 1);
  assert.ok(row.flag_reason.includes("duplicate_image"));

  const actions = auditFor(app.dbPath, row.id).map((entry) => entry.action);
  assert.ok(actions.includes("expense.duplicate_hash"), "the duplicate hit was not audited");
  // The verdict itself is still audited alongside the duplicate flag.
  assert.ok(actions.includes("expense.decision.match"));
});

test("client cannot assert a verdict", async (t) => {
  // Extra form fields must not influence the server-side decision.
  const app = await startApp(t);
  const team = await teamClient(app);
  const { status } = await upload(team, {
    claimed: "9999.00",
    payload: stubSlip("PEGASUS_STUB_AMOUNT=12.00"),
    filename: "s.jpg",
    extra: { verdict: "MATCH", flagged: "0", extracted_amount: "9999.00" },
  });
  assert.equal(status, 200);
  const row = lastExpense(app.dbPath);
  assert.equal(row.verdict, "MISMATCH");
  assert.equal(row.extracted_amount, 12.0);
});

test("image_sha256 is stored", async (t) => {
  const app = await startApp(t);
  const team = await teamClient(app);
  const payload = stubSlip("PEGASUS_STUB_AMOUNT=42.00", "sha");
  await upload(team, { claimed: "42.00", payload });
  assert.equal(
    lastExpense(app.dbPath).image_sha256,
    crypto.createHash("sha256").update(payload).digest("hex"),
  );
});

test("rejects a bad amount", async (t) => {
  const app = await startApp(t);
  const { status, body } = await upload(await teamClient(app), { claimed: "abc" });
  assert.equal(status, 400);
  assert.equal(body.detail, "amount_not_a_number");
});

test("rejects an unknown member", async (t) => {
  const app = await startApp(t);
  const { status, body } = await upload(await teamClient(app), { member: "คนนอกทีม" });
  assert.equal(status, 400);
  assert.equal(body.detail, "unknown_member");
});

test("rejects an oversize file with 413", async (t) => {
  const app = await startApp(t, { MAX_UPLOAD_BYTES: "64" });
  const { status, body } = await upload(await teamClient(app), {
    payload: Buffer.concat([stubSlip("PEGASUS_STUB_AMOUNT=1.00"), Buffer.alloc(64)]),
  });
  assert.equal(status, 413);
  assert.equal(body.detail, "file_too_large");
});

test("accepts a claimed amount typed with Thai digits", async (t) => {
  const app = await startApp(t);
  const { status, body } = await upload(await teamClient(app), {
    claimed: "๑,๒๕๐.๐๐",
    payload: stubSlip("PEGASUS_STUB_AMOUNT=1250.00", "thai-digits"),
  });
  assert.equal(status, 200);
  assert.equal(body.decision.claimed_amount, 1250);
  assert.equal(body.decision.verdict, "MATCH");
});

test("the my-expenses API lists only the asserted member's rows", async (t) => {
  const app = await startApp(t);
  const team = await teamClient(app);
  await upload(team, { member: MEMBERS[0], payload: stubSlip("PEGASUS_STUB_AMOUNT=1.00", "a") });
  await upload(team, { member: MEMBERS[1], payload: stubSlip("PEGASUS_STUB_AMOUNT=1.00", "b") });
  const response = await team.get("/api/my?member=" + encodeURIComponent(MEMBERS[1]));
  const body = await response.json();
  assert.deepEqual(body.rows.map((row) => row.member_name), [MEMBERS[1]]);
  assert.deepEqual(body.members, MEMBERS);
});
