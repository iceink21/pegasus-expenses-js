// Per-member accounts: password hashing, setup codes and the forced change,
// password policy, lockout, the per-IP rate limit, session revocation, CSRF,
// last-admin protection, the admin bootstrap, the recovery CLI, and that no
// secret ever reaches the audit log or the server log.
//
// Limits are set small per test through the same env vars production reads,
// so the production defaults themselves stay as specified (see
// startup-guard.test.js for those).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildApp } from "../src/app.js";
import {
  checkPasswordPolicy,
  createPasswordHasher,
  DEFAULT_SCRYPT_N,
  generateSetupCode,
  normalizeSetupCode,
} from "../src/passwords.js";
import { TokenBucketLimiter } from "../src/ratelimit.js";
import { HttpError } from "../src/http-error.js";
import {
  ADMIN_PASSWORD,
  ADMIN_TEST_PASSWORD,
  adminClient,
  ensureMember,
  login,
  MEMBER_PASSWORD,
  MEMBERS,
  query,
  startApp,
  testEnv,
} from "./helpers.js";

const AUDIT_BY_ACTION = "SELECT * FROM audit_log WHERE action = ? ORDER BY id";
const CODE_PATTERN = /^[23456789A-HJKMNP-Z]{5}-[23456789A-HJKMNP-Z]{5}$/;
const ROOT = fileURLToPath(new URL("../", import.meta.url));

const auditRows = (app, action) => query(app.dbPath, AUDIT_BY_ACTION, action);
const details = (rows) => rows.map((row) => JSON.parse(row.detail));

function writeDb(app, sql, ...params) {
  const db = new DatabaseSync(app.dbPath);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

/** Admin creates an account through the API; returns { id, username, code }. */
async function createViaAdmin(admin, { name, username, role = "member" }) {
  const response = await admin.postJson("/api/admin/members", { name, username, role });
  assert.equal(response.status, 201, "create " + username);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  return { id: body.member.id, username: body.member.username, code: body.setup_code, body };
}

/** Log in with a setup code and set `password`; returns the now-normal client. */
async function activate(app, username, code, password) {
  const client = app.client();
  const first = await login(client, username, code);
  assert.equal(first.status, 303);
  const changed = await client.postJson("/api/account/password", { current_password: code, new_password: password });
  assert.equal(changed.status, 200, "activate " + username);
  return client;
}

// --- hashing -------------------------------------------------------------------

test("scrypt hashes carry their parameters and verify in constant time", async () => {
  const hasher = createPasswordHasher();
  assert.equal(hasher.params.N, DEFAULT_SCRYPT_N);
  assert.equal(DEFAULT_SCRYPT_N, 32768);
  const stored = await hasher.hash("correct horse battery staple");
  // scrypt$N$r$p$<16-byte salt>$<64-byte key>, base64url.
  assert.match(stored, /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
  assert.equal(await hasher.verify("correct horse battery staple", stored), true);
  assert.equal(await hasher.verify("correct horse battery stapl", stored), false);
  assert.notEqual(await hasher.hash("correct horse battery staple"), stored, "salted");

  // The cost travels with the hash: a cheap test hash verifies under the default hasher.
  const cheap = await createPasswordHasher({ scryptN: 1024 }).hash("another password");
  assert.match(cheap, /^scrypt\$1024\$/);
  assert.equal(await hasher.verify("another password", cheap), true);
  // NFC: a decomposed é and a composed é are one password.
  assert.equal(await hasher.verify("cafe\u0301 au lait!", await createPasswordHasher({ scryptN: 1024 }).hash("café au lait!")), true);

  for (const malformed of [null, "", "bcrypt$x", "scrypt$1$2$3", "scrypt$abc$8$1$AAAA$AAAA"]) {
    assert.equal(await hasher.verify("x", malformed), false, String(malformed));
  }
  assert.equal(await hasher.burn(), false);
  assert.match(hasher.hashSync("sync path"), /^scrypt\$32768\$/);
});

test("setup codes: unambiguous alphabet, ~49 bits, typed forms normalize", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const code = generateSetupCode();
    assert.match(code, CODE_PATTERN);
    seen.add(code);
  }
  assert.equal(seen.size, 200);
  assert.equal(normalizeSetupCode(" abcde-fghjk "), "ABCDEFGHJK");
  assert.equal(normalizeSetupCode("ABCDE FGHJK"), "ABCDEFGHJK");
});

test("password policy: 10–128 characters, not the username, not common; no composition rules", () => {
  const code = (password, username = "tiw") => {
    try {
      checkPasswordPolicy(password, username);
      return "ok";
    } catch (error) {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 400);
      return error.detail;
    }
  };
  assert.equal(code(""), "password_required");
  assert.equal(code(undefined), "password_required");
  assert.equal(code("short pw1"), "password_too_short");
  assert.equal(code("abcdefghij".slice(0, 9) + "!"), "ok");
  assert.equal(code("lowercaseonly"), "ok", "no composition rules");
  assert.equal(code("รหัสผ่านไทยยาวพอ"), "ok");
  assert.equal(code("ก".repeat(9)), "password_too_short", "counted in characters, not bytes");
  assert.equal(code("x".repeat(127) + "y"), "ok");
  assert.equal(code("x".repeat(128) + "y"), "password_too_long");
  assert.equal(code("Long.Username", "long.username"), "password_same_as_username");
  assert.equal(code("Password123"), "password_too_common");
  assert.equal(code("qwertyuiop"), "password_too_common");
  assert.equal(code("aaaaaaaaaaaa"), "password_too_common");
});

// --- login ---------------------------------------------------------------------

test("unknown user and wrong password get byte-identical 401s and both cost a hash", async (t) => {
  const app = await startApp(t, { PASSWORD_SCRYPT_N: "16384" });
  const account = await ensureMember(app, MEMBERS[0], { username: "tiw" });
  const attempt = async (username) => {
    const started = process.hrtime.bigint();
    const response = await login(app.client(), username, "not-the-password-1");
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    return { status: response.status, text: await response.text(), length: response.headers.get("content-length"), ms };
  };
  const unknown = [];
  const wrong = [];
  for (let i = 0; i < 5; i += 1) {
    unknown.push(await attempt("nobody-here"));
    wrong.push(await attempt(account.username));
  }
  assert.deepEqual(
    new Set([...unknown, ...wrong].map((entry) => entry.status + " " + entry.length + " " + entry.text)),
    new Set(["401 28 {\"detail\":\"bad_credentials\"}"]),
  );
  // The unknown-user path runs a dummy scrypt instead of answering at once.
  const median = (list) => list.map((entry) => entry.ms).sort((a, b) => a - b)[2];
  assert.ok(median(unknown) > median(wrong) * 0.5, "unknown " + median(unknown) + "ms vs wrong " + median(wrong) + "ms");

  const causes = details(auditRows(app, "auth.login.failure")).map((detail) => [detail.reason, detail.cause]);
  assert.equal(causes.filter(([, cause]) => cause === "unknown_user").length, 5);
  assert.equal(causes.filter(([, cause]) => cause === "wrong_secret").length, 5);
  assert.ok(causes.every(([reason]) => reason === "bad_credentials"));
});

test("a password typed into the username box is not written to the audit log", async (t) => {
  const app = await startApp(t);
  const secret = "My Secret Passphrase!";
  await login(app.client(), secret, secret);
  const [row] = auditRows(app, "auth.login.failure");
  assert.equal(JSON.parse(row.detail).username, "(invalid)");
  assert.equal(row.actor_name, "(invalid)");
  assert.ok(!JSON.stringify(row).includes("Secret"));
});

test("setup-code flow: one-time code, forced change gates every other route, then the code is dead", async (t) => {
  const app = await startApp(t);
  const admin = await adminClient(app);
  const { id, username, code, body } = await createViaAdmin(admin, { name: "นาย", username: "nai" });
  assert.match(code, CODE_PATTERN);
  assert.equal(body.member.needs_setup, true);
  assert.equal(body.member.setup_code_active, true);
  assert.ok(!("setup_code_hash" in body.member) && !("password_hash" in body.member));
  // The list never shows a code again.
  const listed = await (await admin.get("/api/admin/members")).json();
  assert.ok(!JSON.stringify(listed).includes(code));
  assert.ok(!JSON.stringify(listed).includes("scrypt$"));

  const nai = app.client();
  // Typed in lower case without the dash still works.
  const first = await login(nai, "NAI", code.toLowerCase().replace("-", ""));
  assert.equal(first.status, 303);
  assert.equal(first.headers.get("location"), "/account/password");
  const [success] = details(auditRows(app, "auth.login.success")).filter((detail) => detail.username === "nai");
  assert.deepEqual([success.via, success.must_change_password], ["setup_code", true]);

  // Only the change-password page/API and logout are reachable.
  assert.equal((await nai.get("/upload")).headers.get("location"), "/account/password");
  const api = await nai.get("/api/my");
  assert.equal(api.status, 403);
  assert.deepEqual(await api.json(), { detail: "password_change_required", location: "/account/password" });
  assert.equal((await nai.get("/account/password")).status, 200);
  const me = await (await nai.get("/api/account")).json();
  assert.deepEqual(me, { id, username, name: "นาย", role: "member", must_change_password: true, using_setup_code: true });
  const gated = details(query(app.dbPath, "SELECT * FROM audit_log WHERE action = 'access.denied' AND actor_name = 'นาย'"));
  assert.deepEqual(gated.map((detail) => detail.reason), ["must_change_password", "must_change_password"]);

  // Wrong current, weak new, then the real change.
  const wrong = await nai.postJson("/api/account/password", { current_password: "XXXXX-XXXXX", new_password: "a-good-long-password" });
  assert.equal(wrong.status, 400);
  assert.deepEqual(await wrong.json(), { detail: "current_password_wrong" });
  const weak = await nai.postJson("/api/account/password", { current_password: code, new_password: "short" });
  assert.deepEqual([weak.status, (await weak.json()).detail], [400, "password_too_short"]);
  const done = await nai.postJson("/api/account/password", { current_password: code, new_password: "nai-chosen-password" });
  assert.equal(done.status, 200);
  assert.deepEqual(await done.json(), { location: "/upload" });
  assert.equal((await nai.get("/upload")).status, 200, "this device keeps working with the reissued cookie");

  // Single use: the code no longer logs in; the new password does.
  assert.equal((await login(app.client(), "nai", code)).status, 401);
  assert.equal((await login(app.client(), "nai", "nai-chosen-password")).status, 303);
  const [row] = query(app.dbPath, "SELECT * FROM members WHERE id = ?", id);
  assert.deepEqual([row.setup_code_hash, row.setup_code_expires_at, row.must_change_password], [null, null, 0]);
  assert.ok(row.password_changed_at);
  assert.equal(details(auditRows(app, "auth.password.changed")).filter((detail) => detail.via === "setup_code").length, 1);
});

test("an expired setup code is refused like a wrong password", async (t) => {
  const app = await startApp(t);
  const admin = await adminClient(app);
  const { id, code } = await createViaAdmin(admin, { name: "คูการ์", username: "cougar" });
  writeDb(app, "UPDATE members SET setup_code_expires_at = '2000-01-01T00:00:00+00:00' WHERE id = ?", id);
  const response = await login(app.client(), "cougar", code);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { detail: "bad_credentials" });
  const [failure] = details(auditRows(app, "auth.login.failure"));
  assert.deepEqual([failure.reason, failure.cause], ["bad_credentials", "setup_code_expired"]);
});

// --- lockout + rate limit -----------------------------------------------------

const LOCKOUT_ENV = { LOCKOUT_THRESHOLD: "3", LOCKOUT_BASE_SECONDS: "60", LOCKOUT_MAX_SECONDS: "150" };

test("lockout: trips after N failures, refuses even the right password, doubles, caps, expires, resets", async (t) => {
  const app = await startApp(t, LOCKOUT_ENV);
  const account = await ensureMember(app, MEMBERS[0], { username: "tiw" });
  const fail = () => login(app.client(), "tiw", "wrong-password-xyz");
  const lockedSeconds = () => details(auditRows(app, "auth.lockout")).map((detail) => detail.locked_seconds);
  const expire = () => writeDb(app, "UPDATE members SET locked_until = '2000-01-01T00:00:00+00:00' WHERE id = ?", account.id);

  for (let i = 0; i < 3; i += 1) assert.equal((await fail()).status, 401);
  assert.deepEqual(lockedSeconds(), [60]);
  const locked = await login(app.client(), "tiw", MEMBER_PASSWORD);
  assert.equal(locked.status, 423);
  assert.deepEqual(await locked.json(), { detail: "account_locked" });
  assert.equal(details(auditRows(app, "auth.login.failure")).at(-1).reason, "locked");

  // Expired lock: failures count again from zero, and the next lock doubles.
  expire();
  for (let i = 0; i < 3; i += 1) await fail();
  assert.deepEqual(lockedSeconds(), [60, 120]);
  expire();
  for (let i = 0; i < 3; i += 1) await fail();
  assert.deepEqual(lockedSeconds(), [60, 120, 150], "capped at LOCKOUT_MAX_SECONDS");

  // After it expires, a correct password works and resets every counter.
  expire();
  assert.equal((await login(app.client(), "tiw", MEMBER_PASSWORD)).status, 303);
  const [row] = query(app.dbPath, "SELECT failed_logins, locked_until, lockout_count FROM members WHERE id = ?", account.id);
  assert.deepEqual(Object.values(row), [0, null, 0]);
  for (let i = 0; i < 3; i += 1) await fail();
  assert.deepEqual(lockedSeconds(), [60, 120, 150, 60], "back to the base duration");
});

test("an admin can unlock a locked account; the unlock is audited", async (t) => {
  const app = await startApp(t, LOCKOUT_ENV);
  const account = await ensureMember(app, MEMBERS[1], { username: "nai" });
  for (let i = 0; i < 3; i += 1) await login(app.client(), "nai", "wrong-password-xyz");
  assert.equal((await login(app.client(), "nai", MEMBER_PASSWORD)).status, 423);

  const admin = await adminClient(app);
  const listed = (await (await admin.get("/api/admin/members")).json()).members.find((entry) => entry.id === account.id);
  assert.equal(listed.locked, true);
  const response = await admin.postJson("/api/admin/members/" + account.id + "/unlock", {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).member.locked, false);
  assert.equal((await login(app.client(), "nai", MEMBER_PASSWORD)).status, 303);
  const [unlock] = auditRows(app, "member.unlocked");
  assert.equal(unlock.actor_name, "admin");
  assert.equal(JSON.parse(unlock.detail).was_locked, true);
});

test("per-IP rate limit on POST /login answers 429 with Retry-After and is audited", async (t) => {
  const app = await startApp(t, { LOGIN_RATE_LIMIT_ATTEMPTS: "3", LOGIN_RATE_LIMIT_WINDOW_SECONDS: "300" });
  await ensureMember(app, MEMBERS[0], { username: "tiw" });
  for (let i = 0; i < 3; i += 1) assert.equal((await login(app.client(), "tiw", "wrong-password-xyz")).status, 401);
  // Even the right password is refused once the bucket is empty.
  const limited = await login(app.client(), "tiw", MEMBER_PASSWORD);
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { detail: "rate_limited" });
  assert.equal(limited.headers.get("retry-after"), "100");
  const [row] = auditRows(app, "auth.login.failure").filter((entry) => JSON.parse(entry.detail).reason === "rate_limited");
  assert.equal(JSON.parse(row.detail).username, "tiw");
  assert.equal(row.client_ip, "127.0.0.1");
});

test("a spoofed leftmost X-Forwarded-For neither escapes the rate limit nor forges the audit IP", async (t) => {
  const app = await startApp(t, { TRUSTED_PROXY_IPS: "*", LOGIN_RATE_LIMIT_ATTEMPTS: "3" });
  // What arrives through a proxy: client-chosen junk, then what the proxy saw.
  const attempt = (i) =>
    app.client().postForm("/login", { username: "nobody", password: "whatever-123" }, {
      "x-forwarded-for": "10.9.9." + i + ", 198.51.100.7",
    });
  for (let i = 0; i < 3; i += 1) assert.equal((await attempt(i)).status, 401);
  assert.equal((await attempt(99)).status, 429, "one bucket despite a new leftmost entry each time");
  const ips = new Set(auditRows(app, "auth.login.failure").map((row) => row.client_ip));
  assert.deepEqual([...ips], ["198.51.100.7"]);
});

test("CLIENT_IP_HEADER (Fly-Client-IP) keys the bucket and the audit IP, only from a trusted peer", async (t) => {
  const fly = await startApp(t, { TRUSTED_PROXY_IPS: "*", CLIENT_IP_HEADER: "fly-client-ip", LOGIN_RATE_LIMIT_ATTEMPTS: "2" });
  const viaFly = (xff) =>
    fly.client().postForm("/login", { username: "nobody", password: "whatever-123" }, {
      "fly-client-ip": "203.0.113.5",
      "x-forwarded-for": xff,
    });
  assert.equal((await viaFly("1.1.1.1")).status, 401);
  assert.equal((await viaFly("2.2.2.2")).status, 401);
  assert.equal((await viaFly("3.3.3.3")).status, 429, "X-Forwarded-For is not consulted at all");
  assert.deepEqual([...new Set(auditRows(fly, "auth.login.failure").map((row) => row.client_ip))], ["203.0.113.5"]);

  // Same header from a peer that is not a trusted proxy: ignored.
  const direct = await startApp(t, { CLIENT_IP_HEADER: "fly-client-ip", LOGIN_RATE_LIMIT_ATTEMPTS: "2" });
  for (const forged of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) {
    await direct.client().postForm("/login", { username: "nobody", password: "whatever-123" }, { "fly-client-ip": forged });
  }
  const rows = auditRows(direct, "auth.login.failure");
  assert.deepEqual([...new Set(rows.map((row) => row.client_ip))], ["127.0.0.1"]);
  assert.equal(JSON.parse(rows.at(-1).detail).reason, "rate_limited", "forged headers shared one bucket");
});

test("token bucket: bursts to capacity, refills over the window, bounds its memory", () => {
  let clock = 0;
  const limiter = new TokenBucketLimiter({ capacity: 10, windowSeconds: 300, now: () => clock, maxKeys: 3 });
  for (let i = 0; i < 10; i += 1) assert.equal(limiter.take("a").allowed, true);
  const refused = limiter.take("a");
  assert.equal(refused.allowed, false);
  assert.equal(refused.retryAfterSeconds, 30);
  clock += 30_000; // one token per 30 s
  assert.equal(limiter.take("a").allowed, true);
  assert.equal(limiter.take("a").allowed, false);
  assert.equal(limiter.take("b").allowed, true, "keys are independent");
  for (const key of ["c", "d", "e", "f"]) limiter.take(key);
  assert.ok(limiter.buckets.size <= 3);
});

// --- revocation ------------------------------------------------------------------

test("sessions are revoked by password change, logout, disable and role change", async (t) => {
  const app = await startApp(t);
  const admin = await adminClient(app);
  const account = await ensureMember(app, MEMBERS[0], { username: "tiw" });
  const session = async () => {
    const client = app.client();
    assert.equal((await login(client, "tiw", currentPassword)).status, 303);
    return client;
  };
  let currentPassword = MEMBER_PASSWORD;
  const reason = () => JSON.parse(auditRows(app, "access.denied").at(-1).detail).reason;

  // Password change: the other device is out, this one continues.
  const phone = await session();
  const laptop = await session();
  const changed = await laptop.postJson("/api/account/password", { current_password: MEMBER_PASSWORD, new_password: "tiw-second-password" });
  assert.equal(changed.status, 200);
  currentPassword = "tiw-second-password";
  assert.equal((await phone.get("/api/my")).status, 401);
  assert.equal(reason(), "session_revoked");
  assert.equal((await laptop.get("/api/my")).status, 200);

  // Logout ends every device, and the old cookie cannot be replayed.
  const other = await session();
  const stolenCookie = laptop.jar.get("pegasus_session");
  assert.equal((await laptop.request("POST", "/logout")).status, 303);
  assert.equal((await other.get("/api/my")).status, 401);
  const replay = app.client();
  replay.setCookie("pegasus_session", stolenCookie);
  assert.equal((await replay.get("/api/my")).status, 401);
  assert.equal(reason(), "session_revoked");

  // Disable: refused immediately; login says disabled only to the right password.
  const beforeDisable = await session();
  assert.equal((await admin.postJson("/api/admin/members/" + account.id + "/disable", {})).status, 200);
  assert.equal((await beforeDisable.get("/api/my")).status, 401);
  assert.equal(reason(), "account_disabled");
  assert.equal((await login(app.client(), "tiw", "wrong-password-xyz")).status, 401);
  const disabled = await login(app.client(), "tiw", currentPassword);
  assert.equal(disabled.status, 403);
  assert.deepEqual(await disabled.json(), { detail: "account_disabled" });
  assert.equal(details(auditRows(app, "auth.login.failure")).at(-1).reason, "disabled");
  assert.equal((await admin.postJson("/api/admin/members/" + account.id + "/enable", {})).status, 200);
  assert.deepEqual(auditRows(app, "member.disabled").length + auditRows(app, "member.enabled").length, 2);

  // Role change: the member-role session ends; a fresh login carries admin.
  const beforePromotion = await session();
  assert.equal((await admin.postJson("/api/admin/members/" + account.id + "/role", { role: "admin" })).status, 200);
  assert.equal((await beforePromotion.get("/api/my")).status, 401);
  assert.equal(reason(), "session_revoked");
  const promoted = await session();
  assert.equal((await promoted.get("/api/admin/dashboard")).status, 200);
  const [roleRow] = auditRows(app, "member.role_changed");
  assert.deepEqual([JSON.parse(roleRow.detail).from, JSON.parse(roleRow.detail).to], ["member", "admin"]);
});

test("an admin reset (new setup code) ends the account's sessions and clears its password", async (t) => {
  const app = await startApp(t);
  const admin = await adminClient(app);
  const account = await ensureMember(app, MEMBERS[2], { username: "cougar" });
  const client = app.client();
  await login(client, "cougar", MEMBER_PASSWORD);
  const response = await admin.postJson("/api/admin/members/" + account.id + "/setup-code", {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const { setup_code: code } = await response.json();
  assert.equal((await client.get("/api/my")).status, 401);
  assert.equal((await login(app.client(), "cougar", MEMBER_PASSWORD)).status, 401, "old password cleared");
  await activate(app, "cougar", code, "cougar-new-password");
  const [reset] = auditRows(app, "auth.password.reset_issued");
  assert.equal(JSON.parse(reset.detail).source, "admin");
});

// --- CSRF -------------------------------------------------------------------------

test("CSRF: cross-site POSTs are refused and audited; same-origin and non-browser clients pass", async (t) => {
  const app = await startApp(t);
  await ensureMember(app, MEMBERS[0], { username: "tiw" });
  const self = app.base; // http://127.0.0.1:<port>
  const evil = { origin: "https://evil.example" };

  const crossLogin = await app.client().postForm("/login", { username: "tiw", password: MEMBER_PASSWORD }, evil);
  assert.equal(crossLogin.status, 403);
  assert.deepEqual(await crossLogin.json(), { detail: "csrf_rejected" });
  assert.equal(crossLogin.headers.get("set-cookie"), null);
  const [loginRow] = auditRows(app, "auth.login.failure");
  assert.deepEqual([JSON.parse(loginRow.detail).reason, JSON.parse(loginRow.detail).origin], ["csrf", "https://evil.example"]);

  const member = app.client();
  assert.equal((await member.postForm("/login", { username: "tiw", password: MEMBER_PASSWORD }, { origin: self })).status, 303);
  for (const headers of [evil, { origin: "null" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }]) {
    const response = await member.request("POST", "/logout", { headers });
    assert.equal(response.status, 403, JSON.stringify(headers));
  }
  assert.equal((await member.get("/api/my")).status, 200, "still logged in: no cross-site logout");
  const denied = details(auditRows(app, "access.denied")).filter((detail) => detail.reason === "csrf");
  assert.deepEqual(denied.map((detail) => detail.check), ["origin_mismatch", "opaque_origin", "cross_site_fetch", "cross_site_fetch"]);

  // Same-origin by Sec-Fetch-Site alone, and a bare client, both pass.
  assert.equal((await member.request("POST", "/logout", { headers: { "sec-fetch-site": "same-origin" } })).status, 303);
  assert.equal((await login(app.client(), "tiw", MEMBER_PASSWORD)).status, 303);
});

test("CSRF: PUBLIC_ORIGIN pins the origin exactly; a trusted proxy's scheme is enforced", async (t) => {
  const pinned = await startApp(t, { PUBLIC_ORIGIN: "https://pegasus.example" });
  await ensureMember(pinned, MEMBERS[0], { username: "tiw" });
  const form = { username: "tiw", password: MEMBER_PASSWORD };
  assert.equal((await pinned.client().postForm("/login", form, { origin: pinned.base })).status, 403);
  assert.equal((await pinned.client().postForm("/login", form, { origin: "https://pegasus.example" })).status, 303);

  const proxied = await startApp(t, { TRUSTED_PROXY_IPS: "*" });
  await ensureMember(proxied, MEMBERS[0], { username: "tiw" });
  const host = new URL(proxied.base).host;
  const viaProxy = (origin) =>
    proxied.client().postForm("/login", form, { origin, "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.9" });
  assert.equal((await viaProxy("http://" + host)).status, 403, "scheme downgrade refused");
  assert.equal((await viaProxy("https://" + host)).status, 303);
});

// --- admin protections --------------------------------------------------------

test("the last active admin cannot be disabled or demoted, and an admin cannot disable themself", async (t) => {
  const app = await startApp(t);
  const admin = await adminClient(app);
  const [self] = query(app.dbPath, "SELECT id FROM members WHERE username = 'admin'");
  const post = (path, body = {}) => admin.postJson("/api/admin/members/" + self.id + path, body);

  const disableSelf = await post("/disable");
  assert.deepEqual([disableSelf.status, (await disableSelf.json()).detail], [409, "cannot_disable_self"]);
  const demote = await post("/role", { role: "member" });
  assert.deepEqual([demote.status, (await demote.json()).detail], [409, "last_admin"]);
  const refusals = details(auditRows(app, "access.denied")).map((detail) => [detail.reason, detail.action]);
  assert.deepEqual(refusals, [["cannot_disable_self", "disable"], ["last_admin", "role"]]);

  // With a second active admin, the first may step down — and the second
  // (now the last) is protected in turn.
  const second = await createViaAdmin(admin, { name: "รองหัวหน้า", username: "deputy", role: "admin" });
  const deputy = await activate(app, "deputy", second.code, "deputy-password-1");
  assert.equal((await post("/role", { role: "member" })).status, 200);
  const last = await deputy.postJson("/api/admin/members/" + second.id + "/role", { role: "member" });
  assert.equal(last.status, 409);
  // A disabled admin does not count as active.
  const firstBack = await deputy.postJson("/api/admin/members/" + self.id + "/role", { role: "admin" });
  assert.equal(firstBack.status, 200);
  assert.equal((await deputy.postJson("/api/admin/members/" + self.id + "/disable", {})).status, 200);
  assert.equal((await deputy.postJson("/api/admin/members/" + second.id + "/role", { role: "member" })).status, 409);
});

test("account creation refuses duplicates and renaming keeps names unique", async (t) => {
  const app = await startApp(t);
  const admin = await adminClient(app);
  const first = await createViaAdmin(admin, { name: "ติ้ว", username: "tiw" });
  const dupUser = await admin.postJson("/api/admin/members", { name: "อีกคน", username: "TIW" });
  assert.deepEqual([dupUser.status, (await dupUser.json()).detail], [409, "username_taken"]);
  const dupName = await admin.postJson("/api/admin/members", { name: " ติ้ว ", username: "tiw2" });
  assert.deepEqual([dupName.status, (await dupName.json()).detail], [409, "name_taken"]);

  const [self] = query(app.dbPath, "SELECT id FROM members WHERE username = 'admin'");
  const clash = await admin.postJson("/api/admin/members/" + self.id + "/name", { name: "ติ้ว" });
  assert.deepEqual([clash.status, (await clash.json()).detail], [409, "name_taken"]);
  const renamed = await admin.postJson("/api/admin/members/" + self.id + "/name", { name: "หัวหน้าทีม" });
  assert.equal(renamed.status, 200);
  // The principal name follows: the admin's next action is logged under it.
  await admin.get("/api/admin/audit");
  assert.equal(auditRows(app, "admin.view_audit").at(-1).actor_name, "หัวหน้าทีม");
  assert.equal(auditRows(app, "member.renamed").length, 1);
  assert.ok(first.id > self.id);
});

test("an admin renames a placeholder username before issuing the code; clashes 409; sessions end", async (t) => {
  const app = await startApp(t);
  const admin = await adminClient(app);
  // A migrated member: placeholder login, no credential.
  writeDb(app, "INSERT INTO members (name, name_key, created_at, username) VALUES ('ติ้ว', 'ติ้ว', 't', 'member90')");
  const [{ id }] = query(app.dbPath, "SELECT id FROM members WHERE username = 'member90'");
  const post = (body, target = id) => admin.postJson("/api/admin/members/" + target + "/username", body);

  const renamed = await post({ username: "  Tiw.K " });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).member.username, "tiw.k");
  const [audit] = auditRows(app, "member.username_changed");
  assert.deepEqual([audit.actor_name, audit.subject_id, JSON.parse(audit.detail).from, JSON.parse(audit.detail).to],
    ["admin", String(id), "member90", "tiw.k"]);

  // Validation and uniqueness, nothing changed by a refusal.
  for (const [body, status, detail] of [
    [{ username: "x" }, 400, "username_invalid"],
    [{ username: "ติ้ว" }, 400, "username_invalid"],
    [{}, 400, "username_invalid"],
    [{ username: "ADMIN" }, 409, "username_taken"],
  ]) {
    const response = await post(body);
    assert.deepEqual([response.status, (await response.json()).detail], [status, detail], JSON.stringify(body));
  }
  assert.equal((await post({ username: "tiw.k" }, 99999)).status, 404);
  assert.equal(query(app.dbPath, "SELECT username FROM members WHERE id = ?", id)[0].username, "tiw.k");
  assert.equal(auditRows(app, "member.username_changed").length, 1);

  // The setup code then works under the new name only.
  const { setup_code: code } = await (await admin.postJson("/api/admin/members/" + id + "/setup-code", {})).json();
  assert.equal((await login(app.client(), "member90", code)).status, 401);
  const tiw = await activate(app, "tiw.k", code, "tiw-renamed-password");

  // A rename ends the account's existing sessions.
  assert.equal((await tiw.get("/api/my")).status, 200);
  assert.equal((await post({ username: "tiwk" })).status, 200);
  assert.equal((await tiw.get("/api/my")).status, 401);
  assert.equal(JSON.parse(auditRows(app, "access.denied").at(-1).detail).reason, "session_revoked");
  assert.equal((await login(app.client(), "tiwk", "tiw-renamed-password")).status, 303);

  // Members cannot use it.
  const member = await (async () => { const c = app.client(); await login(c, "tiwk", "tiw-renamed-password"); return c; })();
  const denied = await member.postJson("/api/admin/members/" + id + "/username", { username: "hijack" });
  assert.deepEqual([denied.status, (await denied.json()).detail], [403, "admin_required"]);
});

test("a member reaches no /admin or /api/admin route — every attempt denied and audited", async (t) => {
  const app = await startApp(t);
  const member = await ensureMember(app, MEMBERS[0], { username: "tiw" });
  const client = app.client();
  await login(client, "tiw", MEMBER_PASSWORD);

  // Walk the real route table so a new admin route cannot be forgotten here.
  const routes = [];
  const walk = (stack) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) routes.push([method.toUpperCase(), layer.route.path]);
      } else if (layer.handle?.stack) walk(layer.handle.stack);
    }
  };
  walk(app.expressApp.router.stack);
  const adminRoutes = routes.filter(([, path]) =>
    (path.startsWith("/admin") || path.startsWith("/api/admin")) && path !== "/admin/login");
  assert.ok(adminRoutes.length >= 15, "found " + adminRoutes.length);

  const before = query(app.dbPath, "SELECT COUNT(*) AS n FROM audit_log")[0].n;
  for (const [method, path] of adminRoutes) {
    const url = path.replace(":id", String(member.id));
    const response = method === "GET" ? await client.get(url) : await client.postJson(url, { role: "admin", name: "x" });
    if (path.startsWith("/api/")) {
      assert.equal(response.status, 403, method + " " + url);
      assert.deepEqual(await response.json(), { detail: "admin_required" });
    } else {
      assert.equal(response.status, 303, method + " " + url);
      assert.equal(response.headers.get("location"), "/upload");
    }
  }
  const denials = query(app.dbPath, "SELECT * FROM audit_log WHERE id > ? ORDER BY id", before);
  assert.equal(denials.length, adminRoutes.length);
  assert.ok(denials.every((row) => row.action === "access.denied" && JSON.parse(row.detail).reason === "not_admin"));
  const [row] = query(app.dbPath, "SELECT role, disabled FROM members WHERE id = ?", member.id);
  assert.deepEqual(Object.values(row), ["member", 0], "nothing changed");
});

// --- bootstrap + CLI ----------------------------------------------------------

test("bootstrap: the first start creates admin from ADMIN_PASSWORD (forced change); later values are ignored", async (t) => {
  const app = await startApp(t);
  const [created] = auditRows(app, "member.account_created");
  assert.deepEqual(
    [created.actor_kind, created.actor_name, JSON.parse(created.detail).source, JSON.parse(created.detail).username],
    ["system", "bootstrap", "bootstrap", "admin"],
  );
  const admin = app.client();
  const first = await login(admin, "admin", ADMIN_PASSWORD);
  assert.equal(first.status, 303);
  assert.equal(first.headers.get("location"), "/account/password");
  assert.equal((await admin.get("/api/admin/dashboard")).status, 403, "dashboard waits for the change");
  const changed = await admin.postJson("/api/account/password", { current_password: ADMIN_PASSWORD, new_password: ADMIN_TEST_PASSWORD });
  assert.deepEqual(await changed.json(), { location: "/admin" });
  assert.equal((await admin.get("/api/admin/dashboard")).status, 200);

  // Restart with a different ADMIN_PASSWORD: no second admin, and neither the
  // old nor the new env value logs in.
  const env = testEnv({ DB_PATH: app.dbPath, ADMIN_PASSWORD: "a-different-bootstrap-pw" });
  buildApp({ env }).close();
  assert.equal(query(app.dbPath, "SELECT COUNT(*) AS n FROM members WHERE role = 'admin'")[0].n, 1);
  assert.equal(auditRows(app, "member.account_created").length, 1);
  assert.equal((await login(app.client(), "admin", ADMIN_PASSWORD)).status, 401);
  assert.equal((await login(app.client(), "admin", "a-different-bootstrap-pw")).status, 401);
  assert.equal((await login(app.client(), "admin", ADMIN_TEST_PASSWORD)).status, 303);
});

test("admin-reset CLI prints a working code once and audits without it", async (t) => {
  const app = await startApp(t);
  const account = await ensureMember(app, MEMBERS[1], { username: "nai" });
  writeDb(app, "UPDATE members SET disabled = 1, locked_until = '2999-01-01T00:00:00+00:00' WHERE id = ?", account.id);
  const env = { ...process.env, ...testEnv({ DB_PATH: app.dbPath }), LOG_LEVEL: "silent" };
  const stdout = execFileSync(process.execPath, ["scripts/admin-reset.js", "NAI"], { cwd: ROOT, env, encoding: "utf8" });
  const codes = stdout.match(/[23456789A-HJKMNP-Z]{5}-[23456789A-HJKMNP-Z]{5}/g);
  assert.equal(codes.length, 1, stdout);
  const [code] = codes;

  const [reset] = auditRows(app, "auth.password.reset_issued");
  assert.deepEqual([reset.actor_name, JSON.parse(reset.detail).source], ["cli:admin-reset", "cli"]);
  assert.ok(!reset.detail.includes(code) && !reset.detail.includes(normalizeSetupCode(code)));
  assert.equal(auditRows(app, "member.enabled").length, 1, "re-enabled");
  await activate(app, "nai", code, "nai-recovered-password");

  assert.throws(
    () => execFileSync(process.execPath, ["scripts/admin-reset.js", "ghost"], { cwd: ROOT, env, stdio: "pipe" }),
    (error) => error.status === 1 && String(error.stderr).includes("no account"),
  );
});

// --- secrecy -------------------------------------------------------------------

test("no password or setup code used in a full flow appears in the audit log or the server log", async (t) => {
  const logged = [];
  const originalWrite = process.stderr.write;
  const originalLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "debug";
  // Swallowed, not echoed: the point is to inspect it, not to print it.
  process.stderr.write = function capture(chunk) {
    logged.push(String(chunk));
    return true;
  };
  t.after(() => {
    process.stderr.write = originalWrite;
    process.env.LOG_LEVEL = originalLevel;
  });

  const app = await startApp(t, LOCKOUT_ENV);
  const secrets = new Set([ADMIN_PASSWORD, ADMIN_TEST_PASSWORD, MEMBER_PASSWORD]);
  const admin = await adminClient(app);
  const created = await createViaAdmin(admin, { name: "นาย", username: "nai" });
  secrets.add(created.code).add(normalizeSetupCode(created.code));
  for (const wrong of ["wrong-guess-one-1", "wrong-guess-two-2"]) {
    secrets.add(wrong);
    await login(app.client(), "nai", wrong);
  }
  const nai = await activate(app, "nai", created.code, "nai-final-password-1");
  secrets.add("nai-final-password-1");
  secrets.add("nai-rejected-new-pw");
  await nai.postJson("/api/account/password", { current_password: "not-current-pass-9", new_password: "nai-rejected-new-pw" });
  secrets.add("not-current-pass-9");
  const reset = await (await admin.postJson("/api/admin/members/" + created.id + "/setup-code", {})).json();
  secrets.add(reset.setup_code).add(normalizeSetupCode(reset.setup_code));
  for (let i = 0; i < 3; i += 1) await login(app.client(), "nai", "lockout-guess-" + i);
  for (let i = 0; i < 3; i += 1) secrets.add("lockout-guess-" + i);
  await app.client().postForm("/login", { username: "nai", password: "csrf-attempt-pw" }, { origin: "https://evil.example" });
  secrets.add("csrf-attempt-pw");

  const audit = JSON.stringify(query(app.dbPath, "SELECT * FROM audit_log"));
  const log = logged.join("");
  assert.ok(audit.length > 1000 && log.length > 0, "the flow produced audit rows and log lines");
  for (const secret of secrets) {
    assert.ok(!audit.includes(secret), "audit log contains a secret");
    assert.ok(!log.includes(secret), "server log contains a secret");
  }
});
