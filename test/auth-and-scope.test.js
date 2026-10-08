// Port of tests/test_auth_and_scope.py — auth, audit-on-denial, and the
// permission / row-scope split.
//
// SCOPE OF THESE TESTS — read before trusting the names below. The team login
// takes a typed name and seals the resolved member id into the signed session;
// the scope check compares that id with the row's member_id, and nothing in a
// later request can change it. That is a real boundary BETWEEN SESSIONS. It is
// not an identity boundary: anyone who knows the team passcode can log in
// under any name (README §3). These tests pin the session boundary and that
// every denial is audited.

import assert from "node:assert/strict";
import { test } from "node:test";

import { verifySecret } from "../src/auth.js";
import { encodeToken } from "../src/session.js";
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
  await app.client().postForm("/login", { passcode: TEAM_PASSCODE, member_name: MEMBERS[0] });
  const [row] = query(app.dbPath, AUDIT_BY_ACTION, "auth.team_login.success");
  assert.equal(row.actor_name, MEMBERS[0]);
  assert.equal(JSON.parse(row.detail).member_created, true);
});

test("a right passcode with a bad name is refused and audited", async (t) => {
  const app = await startApp(t);
  const response = await app.client().postForm("/login", { passcode: TEAM_PASSCODE, member_name: "   " });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { detail: "member_name_required" });
  const [row] = query(app.dbPath, AUDIT_BY_ACTION, "auth.team_login.failure");
  assert.equal(JSON.parse(row.detail).reason, "member_name_required");
  assert.equal(query(app.dbPath, "SELECT * FROM members").length, 0);
});

test("a wrong passcode never creates a member, whatever name is typed", async (t) => {
  const app = await startApp(t);
  const response = await app.client().postForm("/login", { passcode: "nope", member_name: "ใครก็ได้" });
  assert.equal(response.status, 401);
  assert.equal(query(app.dbPath, "SELECT * FROM members").length, 0);
});

test("a team session without a member id is sent back to log in", async (t) => {
  // Cookies issued before typed names carried {team:true} only.
  const app = await startApp(t);
  const legacy = app.client();
  legacy.setCookie("pegasus_session", encodeToken("test-secret", { team: true, admin: false }));
  const page = await legacy.get("/upload");
  assert.equal(page.status, 303);
  assert.equal(page.headers.get("location"), "/login");
  const api = await legacy.get("/api/my");
  assert.equal(api.status, 401);

  const ghost = app.client();
  ghost.setCookie("pegasus_session", encodeToken("test-secret", { team: true, admin: false, member_id: 999 }));
  assert.equal((await ghost.get("/upload")).status, 303);

  const reasons = query(app.dbPath, AUDIT_BY_ACTION, "access.denied").map((row) => JSON.parse(row.detail).reason);
  assert.deepEqual(reasons, ["no_member_identity", "no_member_identity", "no_member_identity"]);
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

test("another member's row is refused by id and the denial audited", async (t) => {
  const app = await startApp(t);
  const owner = await teamClient(app, MEMBERS[0]);
  await upload(owner, { payload: stubSlip("PEGASUS_STUB_AMOUNT=100.00", "scope") });
  const expenseId = query(app.dbPath, EXPENSES_ORDERED).at(-1).id;

  const other = await teamClient(app, MEMBERS[1]);
  // The old ?member= label is ignored: identity comes from the session only.
  const response = await other.get(
    "/api/expenses/" + expenseId + "?member=" + encodeURIComponent(MEMBERS[0]),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { detail: "scope" });

  const denials = query(app.dbPath, AUDIT_BY_ACTION, "access.denied");
  assert.equal(denials.length, 1, "the scope denial was not audited");
  assert.equal(denials[0].subject_id, String(expenseId));
  assert.equal(denials[0].actor_name, MEMBERS[1]);
  assert.ok(denials[0].detail.includes("out_of_scope"));
});

test("scope follows the member id, not the spelling of the name", async (t) => {
  const app = await startApp(t);
  const first = await teamClient(app, "Tiw");
  await upload(first, { payload: stubSlip("PEGASUS_STUB_AMOUNT=100.00", "own") });
  const expenseId = query(app.dbPath, EXPENSES_ORDERED).at(-1).id;

  const again = await teamClient(app, "  tIW ");
  const response = await again.get("/api/expenses/" + expenseId);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.expense.id, expenseId);
  assert.equal(body.expense.member_name, "Tiw");
  assert.equal(body.detail_level, "member");
  assert.equal(body.view, undefined);
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
