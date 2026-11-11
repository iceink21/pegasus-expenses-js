// Per-member evidence folders: <name>_M<id>/<verdict>/<file>. Covers the folder
// name helper, LocalDiskStorage (new + legacy shapes, tampered refs), the Drive
// backend against a fake Drive, and the review flow end to end.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { isMemberFolderName, memberFolderName } from "../src/storage/base.js";
import { DRIVE_FILES_URL, GoogleDriveStorage } from "../src/storage/gdrive.js";
import { LocalDiskStorage } from "../src/storage/local.js";
import { adminClient, query, startApp, stubSlip, teamClient, upload } from "./helpers.js";

// --- memberFolderName -------------------------------------------------------

test("memberFolderName keeps Thai, appends _M<id>", () => {
  assert.equal(memberFolderName({ memberId: 3, memberName: "สมชาย" }), "สมชาย_M3");
  // NFC: decomposed input comes out composed.
  assert.equal(memberFolderName({ memberId: 1, memberName: "é" }), "é_M1");
  assert.equal(memberFolderName({ memberId: 7, memberName: "  สมชาย   ใจดี " }), "สมชาย_ใจดี_M7");
});

test("memberFolderName neutralises traversal and hostile characters", () => {
  for (const name of ["../x", "..\\x", "../../etc/passwd", "a/b", "a\\b", "x\0y", "a:b*c?d\"e<f>g|h", ".hidden", "...", "../"]) {
    const folder = memberFolderName({ memberId: 5, memberName: name });
    assert.ok(isMemberFolderName(folder), JSON.stringify(name) + " -> " + folder);
    assert.ok(!/[\\/:*?"<>|\0]/.test(folder), folder);
    assert.ok(!folder.includes(".."), folder);
    assert.ok(!folder.startsWith("."), folder);
    assert.ok(folder.endsWith("M5"));
  }
  assert.equal(memberFolderName({ memberId: 5, memberName: "../x" }), "x_M5");
  assert.equal(memberFolderName({ memberId: 5, memberName: "a\u0007b‮c" }), "abc_M5", "control and bidi chars are stripped");
});

test("memberFolderName: empty name falls back to M<id>; long names are capped; ids disambiguate", () => {
  for (const empty of ["", "   ", "...", "/", null, undefined]) {
    assert.equal(memberFolderName({ memberId: 9, memberName: empty }), "M9");
  }
  const long = memberFolderName({ memberId: 12, memberName: "ก".repeat(500) });
  assert.equal(long, "ก".repeat(40) + "_M12");
  assert.notEqual(
    memberFolderName({ memberId: 1, memberName: "สมชาย" }),
    memberFolderName({ memberId: 2, memberName: "สมชาย" }),
  );
  for (const bad of [0, -1, 1.5, "x", null, undefined, NaN]) {
    assert.throws(() => memberFolderName({ memberId: bad, memberName: "a" }), /invalid member id/);
  }
});

test("isMemberFolderName rejects flat folder names and anything path-like", () => {
  for (const ok of ["สมชาย_M3", "M3", "a_M10"]) assert.ok(isMemberFolderName(ok), ok);
  for (const bad of ["verified", "needs-review", "rejected", "..", ".", "", "a/M3", "a\\M3", "M", "x_M", "..M3", "a/../M3", "M3\0"]) {
    assert.ok(!isMemberFolderName(bad), JSON.stringify(bad));
  }
});

// --- LocalDiskStorage -------------------------------------------------------

function tempStorage(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pegasus-member-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, uploads: path.join(dir, "uploads"), storage: new LocalDiskStorage(path.join(dir, "uploads")) };
}

const SLIP = { data: Buffer.from("x"), filename: "a.jpg", contentType: "image/jpeg" };
const MEMBER = { memberId: 3, memberName: "สมชาย" };

test("local store with a member creates dirs lazily; constructor only makes the flat folders", async (t) => {
  const { uploads, storage } = tempStorage(t);
  assert.deepEqual(fs.readdirSync(uploads).sort(), ["needs-review", "rejected", "verified"]);
  const stored = await storage.store({ ...SLIP, folder: "needs-review", ownerTag: "M3", member: MEMBER });
  assert.equal(path.relative(uploads, path.dirname(stored.ref)), path.join("สมชาย_M3", "needs-review"));
  assert.deepEqual(fs.readdirSync(path.join(uploads, "สมชาย_M3")), ["needs-review"], "only the used verdict dir exists");
  // Without a member it is still the flat layout.
  const flat = await storage.store({ ...SLIP, folder: "verified" });
  assert.equal(path.dirname(flat.ref), path.join(uploads, "verified"));
  await assert.rejects(storage.store({ ...SLIP, folder: "../x", member: MEMBER }), /unknown evidence folder/);
});

test("local move: member-layout stays in its member folder; flat and root rows keep the old behaviour", async (t) => {
  const { uploads, storage } = tempStorage(t);
  const stored = await storage.store({ ...SLIP, folder: "needs-review", member: MEMBER });
  const verified = await storage.move(stored.ref, "verified");
  assert.equal(path.relative(uploads, verified.ref), path.join("สมชาย_M3", "verified", path.basename(stored.ref)));
  assert.ok(!fs.existsSync(stored.ref));
  const back = await storage.move(verified.ref, "needs-review");
  assert.equal(back.ref, stored.ref);
  await assert.rejects(storage.move(back.ref, "legacy"), /cannot move to the legacy root/);

  const flat = await storage.store({ ...SLIP, folder: "needs-review" });
  const flatMoved = await storage.move(flat.ref, "rejected");
  assert.equal(path.dirname(flatMoved.ref), path.join(uploads, "rejected"), "a flat row is not migrated");

  const root = path.join(uploads, "20261001T000000_abcdef12_old.jpg");
  fs.writeFileSync(root, "old");
  const rootMoved = await storage.move(root, "verified");
  assert.equal(path.dirname(rootMoved.ref), path.join(uploads, "verified"));
  const toRoot = await storage.move(rootMoved.ref, "legacy");
  assert.equal(toRoot.ref, root);
});

test("local move refuses to overwrite inside a member folder", async (t) => {
  const { storage } = tempStorage(t);
  const stored = await storage.store({ ...SLIP, folder: "needs-review", member: MEMBER });
  const clash = path.join(path.dirname(path.dirname(stored.ref)), "verified");
  fs.mkdirSync(clash, { recursive: true });
  fs.writeFileSync(path.join(clash, path.basename(stored.ref)), "other");
  await assert.rejects(storage.move(stored.ref, "verified"), /destination already exists/);
  assert.ok(fs.existsSync(stored.ref));
});

test("local copy: with a member goes to that member's folder; remove deletes only the copy", async (t) => {
  const { uploads, storage } = tempStorage(t);
  const original = await storage.store({ ...SLIP, folder: "verified" });
  const copy = await storage.copy(original.ref, "needs-review", { ownerTag: "M4", member: { memberId: 4, memberName: "นาย" } });
  assert.equal(path.relative(uploads, path.dirname(copy.ref)), path.join("นาย_M4", "needs-review"));
  assert.ok(fs.existsSync(original.ref));
  await storage.remove(copy.ref);
  assert.ok(!fs.existsSync(copy.ref) && fs.existsSync(original.ref));
  const flatCopy = await storage.copy(original.ref, "rejected", { ownerTag: "M4" });
  assert.equal(path.dirname(flatCopy.ref), path.join(uploads, "rejected"));
});

test("local checkedSource rejects tampered refs for the member shape", async (t) => {
  const { dir, uploads, storage } = tempStorage(t);
  const outside = path.join(dir, "secret.txt");
  fs.writeFileSync(outside, "keep me");
  const stored = await storage.store({ ...SLIP, folder: "needs-review", member: MEMBER });
  const memberDir = path.join(uploads, "สมชาย_M3");

  // traversal
  await assert.rejects(storage.move(path.join(memberDir, "needs-review", "..", "..", "..", "secret.txt"), "verified"), /outside/);
  await assert.rejects(storage.move(path.join(memberDir, "..", "..", "secret.txt"), "verified"), /outside/);
  // wrong depth (4 levels, and 3 levels whose middle is not a verdict)
  const deep = path.join(memberDir, "needs-review", "sub");
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, "f.jpg"), "x");
  await assert.rejects(storage.move(path.join(deep, "f.jpg"), "verified"), /known folder/);
  fs.mkdirSync(path.join(memberDir, "other"), { recursive: true });
  fs.writeFileSync(path.join(memberDir, "other", "f.jpg"), "x");
  await assert.rejects(storage.move(path.join(memberDir, "other", "f.jpg"), "verified"), /known folder/);
  // first component is not a member folder name
  fs.mkdirSync(path.join(uploads, "randomdir", "verified"), { recursive: true });
  fs.writeFileSync(path.join(uploads, "randomdir", "verified", "f.jpg"), "x");
  await assert.rejects(storage.move(path.join(uploads, "randomdir", "verified", "f.jpg"), "rejected"), /known folder/);
  // a directory at the right depth
  fs.mkdirSync(path.join(memberDir, "verified", "adir"), { recursive: true });
  await assert.rejects(storage.move(path.join(memberDir, "verified", "adir"), "rejected"), /not a regular file/);
  // the member's verdict folder itself (depth 2 in a member folder) is not a file either
  await assert.rejects(storage.move(path.join(memberDir, "verified"), "rejected"), /known folder|not a regular file/);
  // a symlink at the right depth
  const link = path.join(memberDir, "verified", "link.jpg");
  fs.symlinkSync(outside, link);
  await assert.rejects(storage.move(link, "rejected"), /not a regular file/);
  await assert.rejects(storage.remove(link), /not a regular file/);
  await assert.rejects(storage.copy(link, "rejected", { member: MEMBER }), /not a regular file/);

  assert.equal(fs.readFileSync(outside, "utf8"), "keep me");
  assert.ok(fs.existsSync(stored.ref), "the legitimate file is untouched");
});

// --- Drive ------------------------------------------------------------------

function serviceAccount() {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const info = {
    client_email: "svc@pegasus.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    token_uri: "https://oauth2.googleapis.com/token",
  };
  return { info, json: Buffer.from(JSON.stringify(info)).toString("base64") };
}

/** A Drive with a real folder tree: folders and files have name + parents. */
function treeDrive(info, { delayCreate = false } = {}) {
  const nodes = new Map([["root-1", { name: "Evidence", parents: [] }]]);
  const calls = [];
  let next = 1;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push({ url: String(input), method, init });
    if (String(input) === info.token_uri) return Response.json({ access_token: "t", expires_in: 3600 });
    if (url.pathname === "/upload/drive/v3/files" && method === "POST") {
      const metadata = JSON.parse(init.body.toString("utf8").split("\r\n\r\n")[1].split("\r\n")[0]);
      const id = "file-" + next++;
      nodes.set(id, { name: metadata.name, parents: metadata.parents, file: true });
      return Response.json({ id, webViewLink: "https://drive/" + id });
    }
    if (url.pathname === "/drive/v3/files" && method === "GET") {
      const q = url.searchParams.get("q");
      const name = q.match(/^name = '((?:[^'\\]|\\.)*)'/)[1].replaceAll("\\'", "'").replaceAll("\\\\", "\\");
      const parent = q.match(/and '([^']+)' in parents/)[1];
      const files = [...nodes].filter(([, n]) => !n.file && n.name === name && n.parents.includes(parent)).map(([id, n]) => ({ id, name: n.name }));
      if (delayCreate) await new Promise((resolve) => setTimeout(resolve, 5));
      return Response.json({ files });
    }
    if (url.pathname === "/drive/v3/files" && method === "POST") {
      const body = JSON.parse(init.body);
      if (delayCreate) await new Promise((resolve) => setTimeout(resolve, 5));
      const id = "folder-" + next++;
      nodes.set(id, { name: body.name, parents: body.parents });
      return Response.json({ id });
    }
    if (method === "POST" && url.pathname.endsWith("/copy")) {
      const body = JSON.parse(init.body);
      const id = "copy-" + next++;
      nodes.set(id, { name: body.name, parents: body.parents, file: true });
      return Response.json({ id, webViewLink: "https://drive/" + id });
    }
    const id = url.pathname.split("/").pop();
    if (method === "DELETE") {
      nodes.delete(id);
      return new Response(null, { status: 204 });
    }
    if (method === "GET") {
      return nodes.has(id) ? Response.json({ id, ...nodes.get(id) }) : new Response("nf", { status: 404 });
    }
    if (method === "PATCH") {
      const node = nodes.get(id);
      const removed = (url.searchParams.get("removeParents") ?? "").split(",").filter(Boolean);
      node.parents = [...new Set([...node.parents.filter((p) => !removed.includes(p)), url.searchParams.get("addParents")])];
      return Response.json({ id, webViewLink: "https://drive/" + id, parents: node.parents });
    }
    return new Response("unexpected", { status: 500 });
  };
  return { fetchImpl, calls, nodes };
}

const pathOf = (nodes, id) => {
  const names = [];
  for (let cur = id; cur; cur = nodes.get(cur)?.parents[0]) names.unshift(nodes.get(cur).name);
  return names.join("/");
};

test("Drive member layout: store -> <root>/<member>/<Verdict>; move stays inside the member folder", async () => {
  const { info, json } = serviceAccount();
  const { fetchImpl, nodes } = treeDrive(info);
  const storage = new GoogleDriveStorage(json, "root-1", { fetchImpl });
  const stored = await storage.store({ ...SLIP, folder: "needs-review", ownerTag: "M3", member: MEMBER });
  assert.equal(pathOf(nodes, stored.ref).replace(/\/[^/]+$/, ""), "Evidence/สมชาย_M3/Needs-Review");

  const moved = await storage.move(stored.ref, "verified");
  assert.equal(moved.ref, stored.ref);
  assert.equal(pathOf(nodes, stored.ref).replace(/\/[^/]+$/, ""), "Evidence/สมชาย_M3/Verified");
  assert.equal(nodes.get(stored.ref).parents.length, 1);
  await storage.move(stored.ref, "needs-review");
  assert.equal(pathOf(nodes, stored.ref).replace(/\/[^/]+$/, ""), "Evidence/สมชาย_M3/Needs-Review");
  await assert.rejects(storage.move(stored.ref, "legacy"), /cannot move to the legacy root/);

  // A second member gets a separate folder; the first member's is reused.
  const other = await storage.store({ ...SLIP, folder: "verified", member: { memberId: 4, memberName: "นาย" } });
  assert.equal(pathOf(nodes, other.ref).replace(/\/[^/]+$/, ""), "Evidence/นาย_M4/Verified");
  const memberFolders = [...nodes.values()].filter((n) => n.name === "สมชาย_M3");
  assert.equal(memberFolders.length, 1);
});

test("Drive: concurrent uploads for one member create each folder once", async () => {
  const { info, json } = serviceAccount();
  const { fetchImpl, nodes } = treeDrive(info, { delayCreate: true });
  const storage = new GoogleDriveStorage(json, "root-1", { fetchImpl });
  await Promise.all(
    Array.from({ length: 6 }, (_, i) => storage.store({ ...SLIP, folder: i % 2 ? "verified" : "needs-review", member: MEMBER })),
  );
  assert.equal([...nodes.values()].filter((n) => n.name === "สมชาย_M3").length, 1);
  assert.equal([...nodes.values()].filter((n) => n.name === "Verified").length, 1);
  assert.equal([...nodes.values()].filter((n) => n.name === "Needs-Review").length, 1);
});

test("Drive: a failed folder creation is not cached", async () => {
  const { info, json } = serviceAccount();
  const drive = treeDrive(info);
  let failOnce = true;
  const fetchImpl = async (input, init) => {
    if (failOnce && (init?.method ?? "GET") === "POST" && String(input).startsWith(DRIVE_FILES_URL + "?")) {
      failOnce = false;
      return new Response("boom", { status: 500 });
    }
    return drive.fetchImpl(input, init);
  };
  const storage = new GoogleDriveStorage(json, "root-1", { fetchImpl });
  await assert.rejects(storage.store({ ...SLIP, folder: "verified", member: MEMBER }), /folder create failed/);
  const stored = await storage.store({ ...SLIP, folder: "verified", member: MEMBER });
  assert.match(pathOf(drive.nodes, stored.ref), /^Evidence\/สมชาย_M3\/Verified\//);
});

test("Drive: flat and root files keep the legacy behaviour; flat overrides still apply", async () => {
  const { info, json } = serviceAccount();
  const { fetchImpl, nodes } = treeDrive(info);
  nodes.set("ov-verified", { name: "MyVerified", parents: ["somewhere-else"] });
  const storage = new GoogleDriveStorage(json, "root-1", { fetchImpl, folderOverrides: { verified: "ov-verified" } });

  const flat = await storage.store({ ...SLIP, folder: "verified" });
  assert.deepEqual(nodes.get(flat.ref).parents, ["ov-verified"], "no member -> flat override");
  await storage.move(flat.ref, "rejected");
  assert.equal(pathOf(nodes, flat.ref).replace(/\/[^/]+$/, ""), "Evidence/Rejected", "a flat file is not migrated into a member folder");

  nodes.set("old-1", { name: "old.jpg", parents: ["root-1"], file: true });
  await storage.move("old-1", "needs-review");
  assert.equal(pathOf(nodes, "old-1"), "Evidence/Needs-Review/old.jpg");
  await storage.move("old-1", "legacy");
  assert.deepEqual(nodes.get("old-1").parents, ["root-1"]);

  // A folder the service account cannot see (404) is treated as flat, not an error.
  nodes.set("old-2", { name: "o.jpg", parents: ["invisible-folder"], file: true });
  await storage.move("old-2", "verified");
  assert.deepEqual(nodes.get("old-2").parents, ["ov-verified"]);
});

test("Drive copy with a member lands in the member's verdict folder", async () => {
  const { info, json } = serviceAccount();
  const { fetchImpl, nodes } = treeDrive(info);
  const storage = new GoogleDriveStorage(json, "root-1", { fetchImpl });
  nodes.set("shared-1", { name: "old.jpg", parents: ["root-1"], file: true });
  const copy = await storage.copy("shared-1", "needs-review", { ownerTag: "M3", member: MEMBER });
  assert.equal(pathOf(nodes, copy.ref).replace(/\/[^/]+$/, ""), "Evidence/สมชาย_M3/Needs-Review");
  assert.deepEqual(nodes.get("shared-1").parents, ["root-1"]);
  await storage.remove(copy.ref);
  assert.ok(!nodes.has(copy.ref));
});

// --- end to end through the app ----------------------------------------------

const row = (app, id) => query(app.dbPath, "SELECT * FROM expenses WHERE id = ?", id)[0];

test("app: upload lands in <name>_M<id>/<verdict>; review moves inside it; evidence_folder stays a bare verdict", async (t) => {
  const app = await startApp(t);
  const team = await teamClient(app);
  const { status, body } = await upload(team, { claimed: "100.00", payload: stubSlip("PEGASUS_STUB_AMOUNT=10.00", "mf1") });
  assert.equal(status, 200);
  const before = row(app, body.expense.id);
  const memberName = query(app.dbPath, "SELECT name FROM members WHERE id = ?", before.member_id)[0].name;
  const folder = memberName + "_M" + before.member_id;
  const uploads = path.resolve(app.uploadDir);
  assert.equal(path.relative(uploads, path.dirname(before.evidence_ref)), path.join(folder, "needs-review"));
  assert.equal(before.evidence_folder, "needs-review");

  const admin = await adminClient(app);
  const res = await admin.postJson("/api/admin/expenses/" + before.id + "/review", { decision: "reject" });
  assert.equal(res.status, 200);
  const after = row(app, before.id);
  assert.equal(path.relative(uploads, path.dirname(after.evidence_ref)), path.join(folder, "rejected"));
  assert.equal(path.basename(after.evidence_ref), path.basename(before.evidence_ref));
  assert.equal(after.evidence_folder, "rejected");
  assert.ok(!fs.existsSync(before.evidence_ref));
});

test("app: a legacy flat-folder row is reviewed in the flat folders (not migrated)", async (t) => {
  const app = await startApp(t);
  const team = await teamClient(app);
  const { body } = await upload(team, { claimed: "100.00", payload: stubSlip("PEGASUS_STUB_AMOUNT=10.00", "mf2") });
  const id = body.expense.id;
  const uploads = path.resolve(app.uploadDir);
  // Rewrite the row to the pre-change layout: a file in the flat needs-review folder.
  const flat = path.join(uploads, "needs-review", "M1_20261001T000000_abcdef12_old.jpg");
  fs.writeFileSync(flat, "old slip");
  const db = new DatabaseSync(app.dbPath);
  db.prepare("UPDATE expenses SET evidence_ref = ? WHERE id = ?").run(flat, id);
  db.close();

  const admin = await adminClient(app);
  assert.equal((await admin.postJson("/api/admin/expenses/" + id + "/review", { decision: "approve", approved_amount: "10.00" })).status, 200);
  const after = row(app, id);
  assert.equal(path.dirname(after.evidence_ref), path.join(uploads, "verified"), "not silently migrated");
  assert.equal(fs.readFileSync(after.evidence_ref, "utf8"), "old slip");
});
