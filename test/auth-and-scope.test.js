// Auth, audit-on-denial, and the permission / row-scope split.
//
// Every person logs in with their own username and password; the session
// names their account (members.id), and the scope check compares that id with
// the row's member_id. Nothing in a later request can change it. These tests
// pin that boundary and that every denial is audited. Account lifecycle,
// lockout, rate limiting, CSRF and revocation live in accounts.test.js.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

import { encodeToken } from "../src/session.js";
import {
  adminClient,
  ensureMember,
  login,
  MEMBER_PASSWORD,
  MEMBERS,
  query,
  startApp,
  stubSlip,
  teamClient,
  upload,
} from "./helpers.js";

const AUDIT_BY_ACTION = "SELECT * FROM audit_log WHERE action = ? ORDER BY id";
const EXPENSES_ORDERED = "SELECT * FROM expenses ORDER BY id";

/** A cookie as the shared-passcode release signed it (salt v1). */
function v1Token(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url") + "." + Math.floor(Date.now() / 1000);
  const key = crypto.createHmac("sha256", secret).update("pegasus-session-v1").digest();
  return body + "." + crypto.createHmac("sha256", key).update(body).digest("base64url");
}

test("upload page requires a session", async (t) => {
  const app = await startApp(t);
  const response = await app.client().get("/upload");
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/login");
});

test("a failed login is audited without the password", async (t) => {
  const app = await startApp(t);
  const account = await ensureMember(app, MEMBERS[0]);
  const response = await login(app.client(), account.username, "wrong-password-123");
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { detail: "bad_credentials" });
  const rows = query(app.dbPath, AUDIT_BY_ACTION, "auth.login.failure");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "failure");
  assert.equal(rows[0].subject_id, String(account.id));
  assert.equal(JSON.parse(rows[0].detail).reason, "bad_credentials");
  assert.ok(!rows[0].detail.includes("wrong-password-123"));
});

test("a successful login is audited under the account's display name", async (t) => {
  const app = await startApp(t);
  const account = await ensureMember(app, MEMBERS[0]);
  const response = await login(app.client(), account.username, MEMBER_PASSWORD);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/upload");
  const [row] = query(app.dbPath, AUDIT_BY_ACTION, "auth.login.success");
  assert.equal(row.actor_name, MEMBERS[0]);
  assert.equal(row.actor_kind, "member");
  assert.deepEqual(
    [JSON.parse(row.detail).username, JSON.parse(row.detail).via, JSON.parse(row.detail).must_change_password],
    [account.username, "password", false],
  );
});

test("login never creates a member, whatever username is typed", async (t) => {
  const app = await startApp(t);
  const before = query(app.dbPath, "SELECT COUNT(*) AS n FROM members")[0].n;
  for (const username of ["ใครก็ได้", "newperson", ""]) {
    const response = await login(app.client(), username, "some-password-123");
    assert.equal(response.status, 401);
  }
  assert.equal(query(app.dbPath, "SELECT COUNT(*) AS n FROM members")[0].n, before);
  assert.equal(query(app.dbPath, "SELECT * FROM audit_log WHERE action LIKE 'member.%'").filter((row) => row.action !== "member.account_created").length, 0);
});

test("old and malformed session cookies are sent back to log in", async (t) => {
  const app = await startApp(t);
  const account = await ensureMember(app, MEMBERS[0]);
  // A genuine shared-passcode-era cookie (v1 salt) for an existing member id.
  const legacy = app.client();
  legacy.setCookie("pegasus_session", v1Token("test-secret", { team: true, admin: true, member_id: account.id }));
  const page = await legacy.get("/upload");
  assert.equal(page.status, 303);
  assert.equal(page.headers.get("location"), "/login");
  assert.equal((await legacy.get("/api/my")).status, 401);

  // Correctly signed v2 tokens that do not name a live account.
  const ghost = app.client();
  ghost.setCookie("pegasus_session", encodeToken("test-secret", { uid: 999, role: "member", sv: 1 }));
  assert.equal((await ghost.get("/upload")).status, 303);
  const shapeless = app.client();
  shapeless.setCookie("pegasus_session", encodeToken("test-secret", { team: true, admin: true }));
  assert.equal((await shapeless.get("/admin")).status, 303);

  const reasons = query(app.dbPath, AUDIT_BY_ACTION, "access.denied").map((row) => JSON.parse(row.detail).reason);
  // The first refusal also expires the bad cookie, so the API call after it
  // arrives with no session at all.
  assert.equal(legacy.jar.has("pegasus_session"), false);
  assert.deepEqual(reasons, ["invalid_session", "no_session", "unknown_account", "invalid_session"]);
});

test("login answers JSON to the page script and a 303 to everything else", async (t) => {
  const app = await startApp(t);
  await adminClient(app); // sets the bootstrap admin's password
  const viaScript = await app.client().postForm(
    "/login",
    { username: "admin", password: "admin-test-password-1" },
    { accept: "application/json" },
  );
  assert.equal(viaScript.status, 200);
  assert.deepEqual(await viaScript.json(), { location: "/admin" });
  assert.match(viaScript.headers.get("set-cookie"), /pegasus_session=.*HttpOnly.*SameSite=Lax/);
});

test("the old admin login URL just points at the one login page", async (t) => {
  const app = await startApp(t);
  const get = await app.client().get("/admin/login");
  assert.equal(get.status, 303);
  assert.equal(get.headers.get("location"), "/login");
  const post = await app.client().postForm("/admin/login", { password: "test-admin-pass" });
  assert.equal(post.status, 303);
  assert.equal(post.headers.get("location"), "/login");
  assert.equal(post.headers.get("set-cookie"), null, "no session from the retired endpoint");
});

test("admin area requires an admin account", async (t) => {
  // A member session is not enough for the admin view.
  const app = await startApp(t);
  const team = await teamClient(app);
  const response = await team.get("/admin");
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/upload");
});

test("session-gate denials are audited where they happen", async (t) => {
  const app = await startApp(t);
  await app.client().get("/admin");
  const team = await teamClient(app);
  await team.get("/admin/export.csv");
  const api = await app.client().get("/api/admin/dashboard");
  assert.equal(api.status, 401);
  assert.deepEqual(await api.json(), { detail: "login_required", location: "/login" });
  const memberApi = await team.get("/api/admin/dashboard");
  assert.equal(memberApi.status, 403);
  assert.deepEqual(await memberApi.json(), { detail: "admin_required" });

  const denials = query(app.dbPath, AUDIT_BY_ACTION, "access.denied");
  assert.deepEqual(
    denials.map((row) => [row.actor_kind, row.subject_type, row.subject_id, JSON.parse(row.detail).reason]),
    [
      ["anonymous", "route", "GET /admin", "no_session"],
      ["member", "route", "GET /admin/export.csv", "not_admin"],
      ["anonymous", "route", "GET /api/admin/dashboard", "no_session"],
      ["member", "route", "GET /api/admin/dashboard", "not_admin"],
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
  assert.equal(JSON.parse(denial.detail).reason, "no_session");
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

test("the username is matched case-insensitively and scope follows the account id", async (t) => {
  const app = await startApp(t);
  const account = await ensureMember(app, "Tiw", { username: "tiw" });
  const first = await teamClient(app, "Tiw");
  await upload(first, { payload: stubSlip("PEGASUS_STUB_AMOUNT=100.00", "own") });
  const expenseId = query(app.dbPath, EXPENSES_ORDERED).at(-1).id;

  const again = app.client();
  assert.equal((await login(again, "  TIW ", MEMBER_PASSWORD)).status, 303);
  const response = await again.get("/api/expenses/" + expenseId);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.expense.id, expenseId);
  assert.equal(body.expense.member_name, "Tiw");
  assert.equal(body.detail_level, "member");
  assert.equal(body.view, undefined);
  assert.equal(query(app.dbPath, EXPENSES_ORDERED).at(-1).member_id, account.id);
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

test("logout is a POST: it clears the session and is audited; GET /logout changes nothing", async (t) => {
  const app = await startApp(t);
  const team = await teamClient(app);
  const page = await team.get("/logout");
  assert.equal(page.status, 200);
  assert.equal((await team.get("/upload")).status, 200, "GET /logout must not log out");
  assert.equal(query(app.dbPath, AUDIT_BY_ACTION, "auth.logout").length, 0);

  const response = await team.request("POST", "/logout");
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/login");
  assert.equal((await team.get("/upload")).status, 303);
  assert.equal(query(app.dbPath, AUDIT_BY_ACTION, "auth.logout").length, 1);
});
