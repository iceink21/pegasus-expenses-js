// Shared test fixtures — the equivalent of tests/conftest.py.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { buildApp } from "../src/app.js";

// Bootstrap-only: becomes the first admin's password (must be changed).
export const ADMIN_PASSWORD = "test-admin-pass";
// Passwords the helpers give accounts they create. Test-only values; the
// audit-secrecy test greps the audit log for them.
export const MEMBER_PASSWORD = "member-test-password-1";
export const ADMIN_TEST_PASSWORD = "admin-test-password-1";
export const MEMBERS = ["ติ้ว", "นาย", "คูการ์"];
export const CATEGORY = "อะไหล่โดรน";

export function stubSlip(marker, salt = "") {
  return Buffer.from("PEGASUS TEST SLIP\n" + marker + "\nsalt:" + salt, "utf8");
}

/** EMVCo TLV string from [tag, value] pairs. */
export function emv(...fields) {
  return fields.map(([tag, value]) => tag + String(value.length).padStart(2, "0") + value).join("");
}

/**
 * A complete, isolated environment. The secrets are explicitly non-default
 * and ALLOW_INSECURE_DEFAULTS is 0 on purpose: if someone reverts one of them
 * to a published default, the suite must fail loudly instead of a bypass
 * hiding it. COOKIE_SECURE=0 because the test client speaks plain http.
 * The QR stage is off by default: it is a bonus, not the tested behaviour
 * (test/qr.test.js covers it on its own).
 *
 * PASSWORD_SCRYPT_N is lowered so the suite runs in seconds, and the login
 * rate limit raised so ordinary tests never hit it; test/accounts.test.js
 * sets small limits where it tests them.
 */
export function testEnv(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pegasus-test-"));
  const env = {
    DB_PATH: path.join(dir, "test.db"),
    LOCAL_UPLOAD_DIR: path.join(dir, "uploads"),
    ADMIN_PASSWORD,
    SESSION_SECRET: "test-secret",
    PASSWORD_SCRYPT_N: "1024",
    LOGIN_RATE_LIMIT_ATTEMPTS: "10000",
    ALLOW_INSECURE_DEFAULTS: "0",
    COOKIE_SECURE: "0",
    EXPENSE_CATEGORIES: CATEGORY + ",อื่น ๆ",
    REQUIRE_REAL_PROVIDERS: "0",
    ENABLE_QR_STAGE: "0",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** Fetch wrapper with a cookie jar; never follows redirects. */
export class Client {
  constructor(base) {
    this.base = base;
    this.jar = new Map();
  }

  setCookie(name, value) {
    this.jar.set(name, value);
  }

  absorb(response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      const expired = attributes.some((attribute) => {
        const [key, raw] = attribute.split("=").map((part) => part.trim());
        return key.toLowerCase() === "expires" && Date.parse(raw) <= Date.now();
      });
      if (expired || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  async request(method, urlPath, { body, headers = {} } = {}) {
    const cookie = [...this.jar].map(([name, value]) => name + "=" + value).join("; ");
    const response = await fetch(this.base + urlPath, {
      method,
      body,
      headers: { ...headers, ...(cookie ? { cookie } : {}) },
      redirect: "manual",
    });
    this.absorb(response);
    return response;
  }

  get(urlPath, headers) {
    return this.request("GET", urlPath, { headers });
  }

  postForm(urlPath, fields, headers) {
    return this.request("POST", urlPath, { body: new URLSearchParams(fields), headers });
  }

  postJson(urlPath, payload, headers = {}) {
    return this.request("POST", urlPath, {
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
    });
  }

  postMultipart(urlPath, fields, file) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    if (file) form.append(file.field, new Blob([file.data], { type: file.type }), file.filename);
    return this.request("POST", urlPath, { body: form, headers: { accept: "application/json" } });
  }
}

/** Build + listen on an ephemeral port; torn down when the test ends. */
export async function startApp(t, envOverrides = {}, { fetchImpl } = {}) {
  const env = testEnv(envOverrides);
  const built = buildApp(fetchImpl ? { env, fetchImpl } : { env });
  const server = await new Promise((resolve) => {
    const listening = built.app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const base = "http://127.0.0.1:" + server.address().port;
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          built.close();
          resolve();
        });
      }),
  );
  return {
    base,
    dbPath: env.DB_PATH,
    uploadDir: env.LOCAL_UPLOAD_DIR,
    ctx: built.ctx,
    // The Express app itself, for tests that walk its route table.
    expressApp: built.app,
    client: () => new Client(base),
  };
}

const INSERT_TEST_ACCOUNT = `
INSERT INTO members (name, name_key, created_at, username, password_hash, role, must_change_password, password_changed_at)
VALUES (?, ?, ?, ?, ?, ?, 0, ?)`;
const SELECT_ACCOUNT_BY_NAME_KEY = "SELECT * FROM members WHERE name_key = ?";
const SET_BOOTSTRAP_ADMIN_PASSWORD =
  "UPDATE members SET password_hash = ?, must_change_password = 0 WHERE username = 'admin'";

/** A login name for a display name: itself when already valid, else a stable hash. */
export function usernameFor(name) {
  const plain = name.trim().toLowerCase();
  if (/^[a-z0-9._-]{3,32}$/.test(plain)) return plain;
  return "u" + crypto.createHash("sha256").update(name.normalize("NFC")).digest("hex").slice(0, 12);
}

/**
 * The account for display name `name`, created directly in the database with
 * a known password when it does not exist yet — what an admin creating the
 * account plus the member setting a password would leave behind.
 */
export async function ensureMember(app, name, { role = "member", password = MEMBER_PASSWORD, username } = {}) {
  const { memberNameKey, normalizeMemberName } = await import("../src/members.js");
  const display = normalizeMemberName(name);
  const db = app.ctx.db;
  const existing = db.prepare(SELECT_ACCOUNT_BY_NAME_KEY).get(memberNameKey(display));
  if (existing) return { id: Number(existing.id), name: existing.name, username: existing.username, password };
  const login = username ?? usernameFor(display);
  const hash = await app.ctx.passwords.hash(password);
  const now = new Date().toISOString().slice(0, 19) + "+00:00";
  const result = db.prepare(INSERT_TEST_ACCOUNT).run(display, memberNameKey(display), now, login, hash, role, now);
  return { id: Number(result.lastInsertRowid), name: display, username: login, password };
}

/** POST /login with a username and password; returns the response. */
export function login(client, username, password) {
  return client.postForm("/login", { username, password });
}

/** A member session for display name `memberName` (account created if new). */
export async function teamClient(app, memberName = MEMBERS[0]) {
  const account = await ensureMember(app, memberName);
  const client = app.client();
  const response = await login(client, account.username, account.password);
  if (response.status !== 303) throw new Error("member login failed: " + response.status);
  client.app = app;
  client.account = account;
  return client;
}

/**
 * A session for the bootstrap admin (username "admin", display name "admin"),
 * its forced first password change already done.
 */
export async function adminClient(app) {
  app.ctx.db.prepare(SET_BOOTSTRAP_ADMIN_PASSWORD).run(await app.ctx.passwords.hash(ADMIN_TEST_PASSWORD));
  const client = app.client();
  const response = await login(client, "admin", ADMIN_TEST_PASSWORD);
  if (response.status !== 303) throw new Error("admin login failed: " + response.status);
  client.app = app;
  client.isAdmin = true;
  return client;
}

/** Read-only query against the app's database file. */
export function query(dbPath, sql, ...params) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

/**
 * POST /upload. A member session also sends `member` as member_name, which the
 * server must ignore. For an admin session, `member` names the member to
 * submit for: the account is created if needed and sent as member_id
 * (`memberId` sends an id as-is; neither = the admin themself).
 */
export async function upload(
  client,
  { member = MEMBERS[0], memberId, claimed = "100.00", payload, filename = "slip.jpg", extra = {} } = {},
) {
  const fields = { category: CATEGORY, claimed_amount: claimed, note: "test" };
  if (memberId !== undefined) fields.member_id = String(memberId);
  else if (client.isAdmin && member) fields.member_id = String((await ensureMember(client.app, member)).id);
  else fields.member_name = member;
  const response = await client.postMultipart(
    "/upload",
    { ...fields, ...extra },
    {
      field: "slip",
      data: payload ?? stubSlip("PEGASUS_STUB_AMOUNT=100.00"),
      type: "image/jpeg",
      filename,
    },
  );
  const body = await response.json();
  return { status: response.status, body };
}
