// A member is never told whether their bill checked out.
//
// For each server outcome (MATCH, MISMATCH, UNREADABLE, duplicate) this
// collects EVERY JSON body a team session can get about the upload: the POST
// response, the result/detail endpoint, the my-expenses list, the upload-form
// config, and the 403 a different member gets. None may carry a verdict field
// or word, the extracted amount, or a flag. Then the admin session must still
// see all of it, in the API, the dashboard, the CSV and the audit log.

import assert from "node:assert/strict";
import { test } from "node:test";

import { adminClient, MEMBERS, query, startApp, stubSlip, teamClient, upload } from "./helpers.js";

// Keys that would reveal the server's judgement or how it was reached.
const FORBIDDEN_KEYS = [
  "verdict",
  "extracted_amount",
  "difference",
  "tolerance",
  "flagged",
  "flag_reason",
  "duplicate_of_id",
  "is_duplicate",
  "extraction_source",
  "extraction_detail",
  "extractor",
  "image_sha256",
  "evidence_backend",
  "evidence_ref",
  "evidence_url",
  "decision",
  "view",
  "using_stub_ocr",
];
// Words, case-insensitive, anywhere in the serialized body.
const FORBIDDEN_WORDS = /match|unreadable|duplicate|flag|toleran|differen|extract|verdict|stub|ocr|llm|qr/i;

function collectKeys(value, into = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => collectKeys(item, into));
  else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      into.add(key);
      collectKeys(inner, into);
    }
  }
  return into;
}

function assertMemberSafe(label, body, { hiddenNumbers = [] } = {}) {
  const keys = collectKeys(body);
  for (const key of FORBIDDEN_KEYS) assert.ok(!keys.has(key), label + " leaks key " + key);
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, FORBIDDEN_WORDS, label + " leaks a verdict word: " + text);
  for (const number of hiddenNumbers) {
    assert.ok(!text.includes(number), label + " leaks the extracted amount " + number + ": " + text);
  }
}

const CASES = [
  { name: "MATCH", claimed: "1250.00", marker: "PEGASUS_STUB_AMOUNT=1250.00", verdict: "MATCH", flag: null },
  {
    name: "MISMATCH",
    claimed: "1250.00",
    marker: "PEGASUS_STUB_AMOUNT=980.00",
    verdict: "MISMATCH",
    flag: "amount_mismatch",
    hiddenNumbers: ["980"],
  },
  { name: "UNREADABLE", claimed: "500.00", marker: "PEGASUS_STUB_UNREADABLE", verdict: "UNREADABLE", flag: null },
];

for (const scenario of CASES) {
  test("member sees no verdict: " + scenario.name, async (t) => {
    const app = await startApp(t);
    const team = await teamClient(app);
    const opts = { hiddenNumbers: scenario.hiddenNumbers ?? [] };

    const { status, body } = await upload(team, {
      claimed: scenario.claimed,
      payload: stubSlip(scenario.marker, scenario.name),
    });
    assert.equal(status, 200);
    assertMemberSafe("POST /upload", body, opts);
    assert.equal(body.status, "received");
    assert.equal(body.result_url, "/result?id=" + body.expense.id);
    assert.deepEqual(Object.keys(body.expense).sort(), [
      "category",
      "claimed_amount",
      "created_at",
      "id",
      "member_name",
      "note",
    ]);

    // The verdict really was computed and stored.
    const [row] = query(app.dbPath, "SELECT * FROM expenses WHERE id = ?", body.expense.id);
    assert.equal(row.verdict, scenario.verdict);
    assert.equal(row.flag_reason, scenario.flag);

    for (const path of ["/api/expenses/" + body.expense.id, "/api/my", "/api/upload-form"]) {
      const response = await team.get(path);
      assert.equal(response.status, 200, path);
      assertMemberSafe(path, await response.json(), opts);
    }

    // Another member's refusal says nothing either.
    const other = await teamClient(app, MEMBERS[1]);
    const denied = await other.get("/api/expenses/" + body.expense.id);
    assert.equal(denied.status, 403);
    assertMemberSafe("403", await denied.json(), opts);

    // The admin still sees everything about the same row.
    const admin = await adminClient(app);
    const full = await (await admin.get("/api/expenses/" + body.expense.id)).json();
    assert.equal(full.detail_level, "admin");
    assert.equal(full.expense.verdict, scenario.verdict);
    assert.equal(full.expense.flag_reason, scenario.flag);
    assert.ok("tolerance" in full.view && "difference" in full.view);
    const audit = query(
      app.dbPath,
      "SELECT action FROM audit_log WHERE subject_type = 'expense' AND subject_id = ?",
      String(body.expense.id),
    ).map((entry) => entry.action);
    assert.ok(audit.includes("expense.decision." + scenario.verdict.toLowerCase()));
  });
}

test("member sees no verdict: duplicate", async (t) => {
  const app = await startApp(t);
  const team = await teamClient(app);
  const payload = stubSlip("PEGASUS_STUB_AMOUNT=310.50", "dup");
  const first = await upload(team, { claimed: "310.50", payload });
  const second = await upload(team, { claimed: "310.50", payload });
  assert.equal(second.status, 200);
  assertMemberSafe("POST /upload (duplicate)", second.body);
  // Identical shape to the first, non-duplicate response.
  assert.deepEqual(Object.keys(second.body).sort(), Object.keys(first.body).sort());

  for (const path of ["/api/expenses/" + second.body.expense.id, "/api/my"]) {
    assertMemberSafe(path, await (await team.get(path)).json());
  }

  const [row] = query(app.dbPath, "SELECT * FROM expenses WHERE id = ?", second.body.expense.id);
  assert.equal(row.duplicate_of_id, first.body.expense.id);
  assert.equal(row.flagged, 1);

  const admin = await adminClient(app);
  const full = await (await admin.get("/api/expenses/" + second.body.expense.id)).json();
  assert.equal(full.view.is_duplicate, true);
  const dashboard = await (await admin.get("/api/admin/dashboard")).json();
  assert.equal(dashboard.flagged_count, 1);
  assert.ok(dashboard.rows.some((entry) => entry.flag_reason === "duplicate_image"));
  const csv = await (await admin.get("/admin/export.csv")).text();
  assert.match(csv, /duplicate_image/);
  assert.match(csv, /,MATCH,/);
  const audit = await (await admin.get("/api/admin/audit")).json();
  assert.ok(audit.rows.some((entry) => entry.action === "expense.duplicate_hash"));
});

test("an admin upload still returns the full decision", async (t) => {
  const app = await startApp(t);
  const admin = await adminClient(app);
  const { status, body } = await upload(admin, {
    member: "ผู้ช่วยใหม่",
    claimed: "1250.00",
    payload: stubSlip("PEGASUS_STUB_AMOUNT=980.00", "admin-full"),
  });
  assert.equal(status, 200);
  assert.equal(body.detail_level, "admin");
  assert.equal(body.decision.verdict, "MISMATCH");
  assert.equal(body.decision.difference, 270);
  assert.equal(body.member_name, "ผู้ช่วยใหม่");
});
