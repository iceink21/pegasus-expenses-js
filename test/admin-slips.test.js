// Admin slip viewer, claims list and slips.zip: access, audit (including the
// denial path), path safety and content.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { adminClient, MEMBERS, query, startApp, stubSlip, teamClient, upload } from "./helpers.js";

const auditRows = (app, action) =>
  query(app.dbPath, "SELECT * FROM audit_log WHERE action = ? ORDER BY id", action);
const expenseRow = (app, id) => query(app.dbPath, "SELECT * FROM expenses WHERE id = ?", id)[0];

function writeDb(app, sql, ...params) {
  const db = new DatabaseSync(app.dbPath);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

/** File names listed in a zip's central directory. */
function zipNames(buffer) {
  const names = [];
  for (let i = 0; i + 46 <= buffer.length; i++) {
    if (buffer.readUInt32LE(i) !== 0x02014b50) continue;
    const nameLength = buffer.readUInt16LE(i + 28);
    names.push(buffer.toString("utf8", i + 46, i + 46 + nameLength));
    i += 45;
  }
  return names;
}

async function setup(t) {
  const app = await startApp(t);
  const admin = await adminClient(app);
  const member = await teamClient(app, MEMBERS[0]);
  // Starts with real JPEG magic bytes so it is served inline; the stub OCR
  // still finds its marker in the text after the header.
  const payload = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    stubSlip("PEGASUS_STUB_AMOUNT=100.00", "slip-a"),
  ]);
  const { status, body } = await upload(member, { claimed: "100.00", payload });
  assert.equal(status, 200);
  return { app, admin, member, payload, id: body.expense.id };
}

test("admin gets the slip bytes with safe headers, and the view is audited", async (t) => {
  const { app, admin, payload, id } = await setup(t);
  const response = await admin.get("/admin/expenses/" + id + "/slip");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(response.headers.get("content-disposition"), null);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
  const rows = auditRows(app, "admin.view_slip");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_kind, "admin");
  assert.equal(rows[0].subject_id, String(id));
  assert.equal(rows[0].outcome, "success");
  assert.notEqual(rows[0].client_ip, "");
});

test("a member is turned away from every slip route, and each denial is audited", async (t) => {
  const { app, member, id } = await setup(t);
  for (const route of ["/admin/expenses/" + id + "/slip", "/admin/slips.zip"]) {
    const response = await member.get(route);
    // Page-style gate: a logged-in non-admin is redirected home, not served.
    assert.equal(response.status, 303, route);
    assert.equal(response.headers.get("location"), "/upload");
  }
  assert.equal((await member.get("/api/admin/expenses")).status, 403);
  const denied = auditRows(app, "access.denied").filter((row) => row.actor_kind === "member");
  assert.equal(denied.length, 3);
  assert.ok(denied.every((row) => JSON.parse(row.detail).reason === "not_admin"));
  assert.equal(auditRows(app, "admin.view_slip").length, 0);
  assert.equal(auditRows(app, "admin.export_slips").length, 0);
});

test("an unauthenticated request is refused and audited", async (t) => {
  const { app, id } = await setup(t);
  const anon = app.client();
  for (const route of ["/admin/expenses/" + id + "/slip", "/admin/slips.zip"]) {
    const response = await anon.get(route);
    assert.equal(response.status, 303, route);
    assert.equal(response.headers.get("location"), "/login");
  }
  assert.equal((await anon.get("/api/admin/expenses", { accept: "application/json" })).status, 401);
  const denied = auditRows(app, "access.denied").filter((row) => row.actor_kind === "anonymous");
  assert.equal(denied.length, 3);
  assert.ok(denied.every((row) => JSON.parse(row.detail).reason === "no_session"));
});

test("a missing expense is 404 and a hostile id never reaches the filesystem", async (t) => {
  const { admin, app, id } = await setup(t);
  assert.equal((await admin.get("/admin/expenses/99999/slip")).status, 404);
  assert.equal((await admin.get("/admin/expenses/007/slip")).status, 422); // no leading zeros
  for (const bad of ["../../etc/passwd", "..%2f..%2fetc%2fpasswd", "%2e%2e%2f", "1%2f..%2f1", "1.5", "-1", "abc", String(id) + "%00"]) {
    const response = await admin.get("/admin/expenses/" + bad + "/slip");
    assert.ok([404, 422].includes(response.status), bad + " -> " + response.status);
  }
  // Probing leaves a trace, all of it failures.
  const probes = auditRows(app, "admin.view_slip");
  assert.ok(probes.length >= 9);
  assert.ok(probes.every((row) => row.outcome === "failure"));
  assert.deepEqual(
    new Set(probes.map((row) => JSON.parse(row.detail).reason)),
    new Set(["not_found", "invalid_id"]),
  );
});

test("a tampered evidence ref cannot read outside the upload directory", async (t) => {
  const { app, admin, id } = await setup(t);
  const secret = path.join(path.dirname(app.uploadDir), "secret.jpg");
  fs.writeFileSync(secret, "TOP SECRET");
  const refs = [
    secret,
    path.join(app.uploadDir, "..", "secret.jpg"),
    path.join(app.uploadDir, "verified"), // a folder, not a file
    "/etc/passwd",
    "",
  ];
  const link = path.join(app.uploadDir, "link.jpg");
  fs.symlinkSync(secret, link);
  refs.push(link); // a symlink inside the directory pointing out
  for (const ref of refs) {
    writeDb(app, "UPDATE expenses SET evidence_ref = ? WHERE id = ?", ref, id);
    const response = await admin.get("/admin/expenses/" + id + "/slip");
    assert.equal(response.status, 404, JSON.stringify(ref));
    assert.ok(!(await response.text()).includes("TOP SECRET"));
  }
  const failures = auditRows(app, "admin.view_slip").filter((row) => row.outcome === "failure");
  assert.equal(failures.length, refs.length);
});

/** Point expense `id` at a new file in the upload root and fetch its slip. */
async function slipFor(app, admin, id, name, bytes) {
  const file = path.join(app.uploadDir, name);
  fs.writeFileSync(file, bytes);
  writeDb(app, "UPDATE expenses SET evidence_ref = ? WHERE id = ?", file, id);
  return admin.get("/admin/expenses/" + id + "/slip");
}

function assertAttachment(response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.match(response.headers.get("content-disposition"), /^attachment/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; sandbox");
}

test("an unknown extension is sent as an attachment, never rendered", async (t) => {
  const { app, admin, id } = await setup(t);
  assertAttachment(await slipFor(app, admin, id, "odd.html", "<script>alert(1)</script>"));
});

test("evil.pdf with PDF bytes is an attachment, not inline application/pdf", async (t) => {
  const { app, admin, id } = await setup(t);
  assertAttachment(await slipFor(app, admin, id, "evil.pdf", "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj"));
});

test("a .jpg whose bytes are not a JPEG is an attachment", async (t) => {
  const { app, admin, id } = await setup(t);
  assertAttachment(await slipFor(app, admin, id, "fake.jpg", "<html><script>alert(1)</script></html>"));
  assertAttachment(await slipFor(app, admin, id, "fake.png", Buffer.from([0xff, 0xd8, 0xff, 0xe0]))); // JPEG bytes, PNG name
  assertAttachment(await slipFor(app, admin, id, "short.jpg", ""));
});

test("real PNG, WEBP and HEIC headers are still served inline", async (t) => {
  const { app, admin, id } = await setup(t);
  const cases = {
    "a.png": ["image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    "a.webp": ["image/webp", Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1")],
    "a.heic": ["image/heic", Buffer.from("\0\0\0\x18ftypheic", "latin1")],
  };
  for (const [name, [type, bytes]] of Object.entries(cases)) {
    const response = await slipFor(app, admin, id, name, bytes);
    assert.equal(response.status, 200, name);
    assert.equal(response.headers.get("content-type"), type, name);
    assert.equal(response.headers.get("content-disposition"), null, name);
    assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  }
});

test("a Google Drive row redirects to its Drive link", async (t) => {
  const { app, admin, id } = await setup(t);
  writeDb(
    app,
    "UPDATE expenses SET evidence_backend = 'GoogleDriveStorage', evidence_ref = 'fileid', evidence_url = ? WHERE id = ?",
    "https://drive.google.com/file/d/fileid/view",
    id,
  );
  const response = await admin.get("/admin/expenses/" + id + "/slip");
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://drive.google.com/file/d/fileid/view");
  writeDb(app, "UPDATE expenses SET evidence_url = NULL WHERE id = ?", id);
  assert.equal((await admin.get("/admin/expenses/" + id + "/slip")).status, 404);
  for (const url of ["https://evil.example/x", "https://drive.google.com.evil.example/x", "http://drive.google.com/x", "javascript:alert(1)"]) {
    writeDb(app, "UPDATE expenses SET evidence_url = ? WHERE id = ?", url, id);
    assert.equal((await admin.get("/admin/expenses/" + id + "/slip")).status, 404, url);
  }
});

test("claims list filters by verdict folder and member name", async (t) => {
  const { app, admin, id } = await setup(t);
  const other = await teamClient(app, MEMBERS[1]);
  const second = await upload(other, { claimed: "55.00", payload: stubSlip("PEGASUS_STUB_AMOUNT=999.00", "b") });
  assert.equal(second.status, 200);
  const list = async (qs) => (await (await admin.get("/api/admin/expenses" + qs, { accept: "application/json" })).json()).rows;
  const all = await list("");
  assert.equal(all.length, 2);
  for (const key of ["evidence_ref", "evidence_url", "image_sha256", "extraction_detail"]) {
    assert.ok(all.every((row) => !(key in row)), key + " must not reach the browser");
  }
  const mine = await list("?member=" + encodeURIComponent(MEMBERS[0]));
  assert.deepEqual(mine.map((row) => row.id), [id]);
  const folder = expenseRow(app, second.body.expense.id).evidence_folder;
  assert.ok((await list("?verdict=" + folder)).some((row) => row.id === second.body.expense.id));
  assert.equal((await list("?verdict=rejected")).length, 0);
  assert.equal((await list("?member=%25")).length, 0); // % is literal, not a wildcard
  const bad = await admin.get("/api/admin/expenses?verdict=x", { accept: "application/json" });
  assert.equal(bad.status, 400);
});

test("slips.zip holds <name>_M<id>/<verdict>/<file> for every slip and is audited", async (t) => {
  const { app, admin, payload, id } = await setup(t);
  const other = await teamClient(app, MEMBERS[1]);
  const second = await upload(other, { claimed: "55.00", payload: stubSlip("PEGASUS_STUB_AMOUNT=999.00", "b") });
  const response = await admin.get("/admin/slips.zip");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/zip");
  assert.match(response.headers.get("content-disposition"), /^attachment/);
  const zip = Buffer.from(await response.arrayBuffer());
  const names = zipNames(zip);
  assert.equal(names.length, 2);
  for (const rowId of [id, second.body.expense.id]) {
    const row = expenseRow(app, rowId);
    const member = query(app.dbPath, "SELECT name FROM members WHERE id = ?", row.member_id)[0].name;
    const expected = member + "_M" + row.member_id + "/" + row.evidence_folder + "/" + path.basename(row.evidence_ref);
    assert.ok(names.includes(expected), expected + " not in " + names.join(", "));
  }
  assert.ok(zip.includes(payload), "stored (uncompressed) slip bytes are in the archive");
  // "started" is written before streaming; the close handler adds the outcome.
  const deadline = Date.now() + 2000;
  while (auditRows(app, "admin.export_slips").length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const rows = auditRows(app, "admin.export_slips");
  assert.deepEqual(rows.map((row) => row.outcome), ["started", "success"]);
  assert.deepEqual(JSON.parse(rows[0].detail), { files: 2, skipped: 0 });
  assert.deepEqual(JSON.parse(rows[1].detail), { files: 2, skipped: 0, warnings: 0 });
  assert.ok(rows.every((row) => row.client_ip !== ""));
});

// --- slips.zip close handling ---------------------------------------------------

const exportRows = (app) => auditRows(app, "admin.export_slips").map((row) => row.outcome);

async function waitFor(check, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
}

/** GET with node:http so the test can hang up mid-body; `onResponse(res, req)` decides when. */
function rawGet(base, urlPath, client, onResponse) {
  const cookie = [...client.jar].map(([name, value]) => name + "=" + value).join("; ");
  return new Promise((resolve, reject) => {
    const req = http.get(base + urlPath, { headers: { cookie } }, (res) => {
      onResponse(res, req);
      resolve();
    });
    req.on("error", () => resolve()); // our own destroy() surfaces here
    setTimeout(() => reject(new Error("no response")), 5000).unref();
  });
}

test("a zip the client abandons mid-stream writes started then exactly one aborted", async (t) => {
  const { app, admin, id } = await setup(t);
  // Big enough that the socket buffers cannot swallow it: the transfer stalls.
  const big = path.join(app.uploadDir, "big.jpg");
  fs.writeFileSync(big, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(40 * 1024 * 1024)]));
  writeDb(app, "UPDATE expenses SET evidence_ref = ? WHERE id = ?", big, id);
  await rawGet(app.base, "/admin/slips.zip", admin, (res, req) => {
    res.once("data", () => {
      res.pause();
      setTimeout(() => req.destroy(), 100);
    });
  });
  await waitFor(() => exportRows(app).length >= 2);
  await new Promise((resolve) => setTimeout(resolve, 300)); // a duplicate row would show up here
  assert.deepEqual(exportRows(app), ["started", "aborted"]);
});

test("a client that leaves during the file loop still gets one aborted row", async (t) => {
  const { app, admin } = await setup(t);
  const storage = app.ctx.providers.storage;
  const real = storage.checkedSource.bind(storage);
  storage.checkedSource = async (ref) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return real(ref);
  };
  t.after(() => { storage.checkedSource = real; });
  // No response can arrive before the loop ends; hang up first.
  const cookie = [...admin.jar].map(([name, value]) => name + "=" + value).join("; ");
  await new Promise((resolve) => {
    const req = http.get(app.base + "/admin/slips.zip", { headers: { cookie } });
    req.on("error", resolve);
    setTimeout(() => req.destroy(), 100);
  });
  await waitFor(() => exportRows(app).length >= 2, 4000);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(exportRows(app), ["started", "aborted"]);
});

test("a failing closing audit write is logged and does not take the process down", async (t) => {
  const { app, admin } = await setup(t);
  // A real failure: the database refuses the closing row (and only that row).
  writeDb(
    app,
    "CREATE TRIGGER no_close_row BEFORE INSERT ON audit_log " +
      "WHEN NEW.action = 'admin.export_slips' AND NEW.outcome IN ('success', 'aborted') " +
      "BEGIN SELECT RAISE(ABORT, 'disk full (simulated)'); END",
  );
  const previousLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "error";
  const written = [];
  const stderr = t.mock.method(process.stderr, "write", (chunk) => { written.push(String(chunk)); return true; });
  t.after(() => {
    stderr.mock.restore();
    process.env.LOG_LEVEL = previousLevel;
  });
  const response = await admin.get("/admin/slips.zip");
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  await waitFor(() => written.some((line) => line.includes("closing audit row")));
  assert.ok(written.some((line) => line.includes("closing audit row") && line.includes("simulated")), written.join(""));
  assert.deepEqual(exportRows(app), ["started"]);
  // Still serving.
  assert.equal((await admin.get("/healthz")).status, 200);
  assert.equal((await admin.get("/admin/slips.zip")).status, 200);
});
