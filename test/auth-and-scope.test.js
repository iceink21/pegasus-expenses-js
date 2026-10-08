// Port of tests/test_auth_and_scope.py — auth, audit-on-denial, and the
// permission / row-label split.
//
// SCOPE OF THESE TESTS — read before trusting the names below. There is no
// enforced per-member access boundary in this app and these tests do not claim
// one. The member name is a CLIENT-ASSERTED label supplied as `?member=`; the
// session cookie proves only that someone knew the shared team passcode and
// carries no member identity. What is genuinely tested is that the row-label
// check fires and is audited when the asserted label does not match the row —
// a mislabelling guard, plus proof that the denial path writes its audit row.

import assert from "node:assert/strict";
import { test } from "node:test";

import { verifySecret } from "../src/auth.js";
import {
  ADMIN_PASSWORD,
  adminClient,
  MEMBERS,
  query,
  startApp,
  stubSlip,
  TEAM_PASSCODE,
  teamClient,
  upload,
} from "./helpers.js";

const AUDIT_BY_ACTION = "SELECT * FROM audit_log WHERE action = ? ORDER BY id";
const EXPENSES_ORDERED = "SELECT * FROM expenses ORDER BY id";

test("upload page requires a session", async (t) => {
  const app = await startApp(t);
  const response = await app.client().get("/upload");
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/login");
});

test("failed team passcode is audited", async (t) => {
  const app = await startApp(t);
  const response = await app.client().postForm("/login", { passcode: "nope" });
  assert.equal(response.status, 401);
  const rows = query(app.dbPath, AUDIT_BY_ACTION, "auth.team_login.failure");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "failure");
});

test("failed admin password is audited", async (t) => {
  const app = await startApp(t);
  const response = await app.client().postForm("/admin/login", { password: "nope" });
  assert.equal(response.status, 401);
  assert.equal(query(app.dbPath, AUDIT_BY_ACTION, "auth.admin_login.failure").length, 1);
});

test("successful logins are audited", async (t) => {
  const app = await startApp(t);
  await app.client().postForm("/login", { passcode: TEAM_PASSCODE });
  assert.equal(query(app.dbPath, AUDIT_BY_ACTION, "auth.team_login.success").length, 1);
});

test("login answers JSON to the page script and a 303 to everything else", async (t) => {
  const app = await startApp(t);
  const viaScript = await app.client().postForm(
    "/admin/login",
    { password: ADMIN_PASSWORD },
    { accept: "application/json" },
  );
  assert.equal(viaScript.status, 200);
  assert.deepEqual(await viaScript.json(), { location: "/admin" });
  assert.match(viaScript.headers.get("set-cookie"), /pegasus_session=.*HttpOnly.*SameSite=Lax/);
});

test("admin area requires an admin session", async (t) => {
  // A plain team session is not enough for the admin view.
  const app = await startApp(t);
  const team = await teamClient(app);
  const response = await team.get("/admin");
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/admin/login");
});

test("session-gate denials are audited where they happen", async (t) => {
  // The Python dependency redirected without an audit row; the port writes one.
  const app = await startApp(t);
  await app.client().get("/admin");
  const team = await teamClient(app);
  await team.get("/admin/export.csv");
  const api = await app.client().get("/api/admin/dashboard");
  assert.equal(api.status, 401);
  assert.deepEqual(await api.json(), { detail: "login_required", location: "/admin/login" });

  const denials = query(app.dbPath, AUDIT_BY_ACTION, "access.denied");
  assert.deepEqual(
    denials.map((row) => [row.actor_kind, row.subject_type, row.subject_id, JSON.parse(row.detail).reason]),
    [
      ["anonymous", "route", "GET /admin", "no_admin_session"],
      ["member", "route", "GET /admin/export.csv", "no_admin_session"],
      ["anonymous", "route", "GET /api/admin/dashboard", "no_admin_session"],
    ],
  );
});

test("unauthenticated upload is refused and audited before the body is read", async (t) => {
  const app = await startApp(t);
  const { status, body } = await upload(app.client());
  assert.equal(status, 401);
  assert.equal(body.location, "/login");
  assert.equal(query(app.dbPath, EXPENSES_ORDERED).length, 0);
  const [denial] = query(app.dbPath, AUDIT_BY_ACTION, "access.denied");
  assert.equal(denial.subject_id, "POST /upload");
  assert.equal(JSON.parse(denial.detail).reason, "no_team_session");
});

test("mismatched member label is refused and audited", async (t) => {
  // NOT a proof of isolation: the same session made both requests and chose
  // the mismatching label itself. What this pins is that the check runs and
  // that the denial reaches the audit log.
  const app = await startApp(t);
  const team = await teamClient(app);
  await upload(team, {
    member: MEMBERS[0],
    claimed: "100.00",
    payload: stubSlip("PEGASUS_STUB_AMOUNT=100.00", "scope"),
  });
  const expenseId = query(app.dbPath, EXPENSES_ORDERED).at(-1).id;

  const response = await team.get(
    "/api/expenses/" + expenseId + "?member=" + encodeURIComponent(MEMBERS[1]),
  );
  assert.equal(response.status, 403);

  const denials = query(app.dbPath, AUDIT_BY_ACTION, "access.denied");
  assert.equal(denials.length, 1, "the row-label denial was not audited");
  assert.equal(denials[0].subject_id, String(expenseId));
  assert.ok(denials[0].detail.includes("out_of_scope"));
});

test("matching member label can read the row", async (t) => {
  const app = await startApp(t);
  const team = await teamClient(app);
  await upload(team, { payload: stubSlip("PEGASUS_STUB_AMOUNT=100.00", "own") });
  const expenseId = query(app.dbPath, EXPENSES_ORDERED).at(-1).id;
  const response = await team.get(
    "/api/expenses/" + expenseId + "?member=" + encodeURIComponent(MEMBERS[0]),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.expense.id, expenseId);
  assert.deepEqual(body.view, { difference: 0, tolerance: 1, is_duplicate: false });
});

test("expense id must be an integer", async (t) => {
  const app = await startApp(t);
  const team = await teamClient(app);
  const response = await team.get("/api/expenses/abc?member=" + encodeURIComponent(MEMBERS[0]));
  assert.equal(response.status, 422);
});

test("admin sees every row", async (t) => {
  const app = await startApp(t);
  const admin = await adminClient(app);
  await upload(admin, {
    member: MEMBERS[1],
    claimed: "77.00",
    payload: stubSlip("PEGASUS_STUB_AMOUNT=77.00", "admin"),
  });
  assert.equal((await admin.get("/admin")).status, 200);
  const response = await admin.get("/api/admin/dashboard");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.rows.some((row) => row.member_name === MEMBERS[1]));
  assert.equal(body.providers.slip_verifier, "NullSlipVerifier");
});

test("admin actions are audited", async (t) => {
  const app = await startApp(t);
  const admin = await adminClient(app);
  const csv = await admin.get("/admin/export.csv");
  assert.equal(csv.status, 200);
  const bytes = Buffer.from(await csv.arrayBuffer());
  assert.ok(bytes.subarray(0, 3).equals(Buffer.from("﻿", "utf8")));
  assert.equal(query(app.dbPath, AUDIT_BY_ACTION, "admin.export_csv").length, 1);

  await admin.get("/api/admin/audit");
  assert.equal(query(app.dbPath, AUDIT_BY_ACTION, "admin.view_audit").length, 1);
});

test("tampered session cookie is rejected", async (t) => {
  const app = await startApp(t);
  const client = app.client();
  client.setCookie("pegasus_session", "not-a-valid-signed-value");
  assert.equal((await client.get("/upload")).status, 303);
});

test("logout clears the session and is audited", async (t) => {
  const app = await startApp(t);
  const team = await teamClient(app);
  const response = await team.get("/logout");
  assert.equal(response.headers.get("location"), "/login");
  assert.equal((await team.get("/upload")).status, 303);
  assert.equal(query(app.dbPath, AUDIT_BY_ACTION, "auth.logout").length, 1);
});

test("constant-time secret comparison", () => {
  assert.equal(verifySecret("abc", "abc"), true);
  assert.equal(verifySecret("abc", "abd"), false);
  assert.equal(verifySecret("", "abc"), false);
});
