// Shared test fixtures — the equivalent of tests/conftest.py.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { buildApp } from "../src/app.js";

export const TEAM_PASSCODE = "test-team-pass";
export const ADMIN_PASSWORD = "test-admin-pass";
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
 * A complete, isolated environment. The three secrets are explicitly
 * non-default and ALLOW_INSECURE_DEFAULTS is 0 on purpose: if someone reverts
 * one of them to a published default, the suite must fail loudly instead of a
 * bypass hiding it. COOKIE_SECURE=0 because the test client speaks plain http.
 * The QR stage is off by default: it is a bonus, not the tested behaviour
 * (test/qr.test.js covers it on its own).
 */
export function testEnv(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pegasus-test-"));
  const env = {
    DB_PATH: path.join(dir, "test.db"),
    LOCAL_UPLOAD_DIR: path.join(dir, "uploads"),
    TEAM_PASSCODE,
    ADMIN_PASSWORD,
    SESSION_SECRET: "test-secret",
    ALLOW_INSECURE_DEFAULTS: "0",
    COOKIE_SECURE: "0",
    TEAM_MEMBERS: MEMBERS.join(","),
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

  postMultipart(urlPath, fields, file) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    if (file) form.append(file.field, new Blob([file.data], { type: file.type }), file.filename);
    return this.request("POST", urlPath, { body: form, headers: { accept: "application/json" } });
  }
}

/** Build + listen on an ephemeral port; torn down when the test ends. */
export async function startApp(t, envOverrides = {}) {
  const env = testEnv(envOverrides);
  const built = buildApp({ env });
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
  return { base, dbPath: env.DB_PATH, ctx: built.ctx, client: () => new Client(base) };
}

export async function teamClient(app) {
  const client = app.client();
  const response = await client.postForm("/login", { passcode: TEAM_PASSCODE });
  if (response.status !== 303) throw new Error("team login failed: " + response.status);
  return client;
}

export async function adminClient(app) {
  const client = app.client();
  const response = await client.postForm("/admin/login", { password: ADMIN_PASSWORD });
  if (response.status !== 303) throw new Error("admin login failed: " + response.status);
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

export async function upload(
  client,
  { member = MEMBERS[0], claimed = "100.00", payload, filename = "slip.jpg", extra = {} } = {},
) {
  const response = await client.postMultipart(
    "/upload",
    { member_name: member, category: CATEGORY, claimed_amount: claimed, note: "test", ...extra },
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
