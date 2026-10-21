// New coverage with no Python counterpart: the Python QR decoders depended on
// native libraries and were left untested, and Drive went through Google's SDK.
// Here both run against real artefacts — a rendered QR PNG and a real RSA key.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

import QRCode from "qrcode";
import sharp from "sharp";

import { QRAmountExtractor } from "../src/extraction/qr.js";
import { decodeQrPayloads, looksLikeRasterImage } from "../src/extraction/qr-decode.js";
import { DRIVE_FILES_URL, DRIVE_UPLOAD_URL, GoogleDriveStorage } from "../src/storage/gdrive.js";
import { emv } from "./helpers.js";

const BILL_QR = emv(["00", "01"], ["01", "12"], ["54", "250.00"], ["58", "TH"], ["63", "ABCD"]);
const SLIP_QR = emv(["00", "01"], ["01", "12"], ["58", "TH"], ["62", "0104ABC1"]);

const qrPng = (payload) => QRCode.toBuffer(payload, { type: "png", width: 400, margin: 4 });

test("a bill QR photographed as a PNG yields its tag-54 amount", async () => {
  const result = await new QRAmountExtractor().extract(await qrPng(BILL_QR));
  assert.equal(result.amount, 250.0);
  assert.equal(result.detail, "EMVCo tag 54");
  assert.equal(result.rawText, BILL_QR);
});

test("a JPEG re-encode of the QR still decodes", async () => {
  const jpeg = await sharp(await qrPng(BILL_QR)).jpeg({ quality: 70 }).toBuffer();
  assert.equal((await new QRAmountExtractor().extract(jpeg)).amount, 250.0);
});

test("a slip QR decodes but carries no amount — expected, not an error", async () => {
  const result = await new QRAmountExtractor().extract(await qrPng(SLIP_QR));
  assert.equal(result.found, false);
  assert.equal(result.detail, "QR without amount");
  assert.ok(result.notes.some((note) => note.includes("no tag 54")));
});

test("non-raster bytes never reach the image decoder", async () => {
  const svg = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
  assert.equal(looksLikeRasterImage(svg), false);
  assert.deepEqual(await decodeQrPayloads(svg), {
    payloads: [],
    notes: ["image bytes were not decodable as an image"],
  });
  const truncatedJpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]);
  assert.equal((await decodeQrPayloads(truncatedJpeg)).payloads.length, 0);
});

function serviceAccount() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const info = {
    client_email: "svc@pegasus.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    token_uri: "https://oauth2.googleapis.com/token",
  };
  return { info, publicKey, json: Buffer.from(JSON.stringify(info)).toString("base64") };
}

/**
 * A fake Drive: dispatches on method + URL shape, records every call, and
 * keeps a parents map so moves can be checked end to end.
 * `existingFolders` maps a folder NAME to an id that a lookup will find.
 */
function fakeDrive(info, { existingFolders = {} } = {}) {
  const calls = [];
  const parents = new Map();
  let nextFolder = 1;
  let nextFile = 9;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push({ url: String(input), method, init });
    if (String(input) === info.token_uri) return Response.json({ access_token: "token-123", expires_in: 3600 });
    if (url.pathname === "/upload/drive/v3/files" && method === "POST") {
      const id = "file-" + nextFile++;
      const metadata = JSON.parse(init.body.toString("utf8").split("\r\n\r\n")[1].split("\r\n")[0]);
      parents.set(id, metadata.parents);
      return Response.json({ id, webViewLink: "https://drive.google.com/file/d/" + id });
    }
    if (url.pathname === "/drive/v3/files" && method === "GET") {
      const name = url.searchParams.get("q").match(/^name = '([^']+)'/)[1];
      return Response.json({ files: existingFolders[name] ? [{ id: existingFolders[name], name }] : [] });
    }
    if (url.pathname === "/drive/v3/files" && method === "POST") {
      return Response.json({ id: "folder-new-" + nextFolder++ });
    }
    if (method === "POST" && url.pathname.endsWith("/copy")) {
      const id = "copy-" + nextFile++;
      parents.set(id, JSON.parse(init.body).parents);
      return Response.json({ id, webViewLink: "https://drive.google.com/file/d/" + id });
    }
    const fileId = url.pathname.split("/").pop();
    if (method === "DELETE") {
      parents.delete(fileId);
      return new Response(null, { status: 204 });
    }
    if (method === "GET") return Response.json({ id: fileId, parents: parents.get(fileId) ?? ["shared-folder-1"] });
    if (method === "PATCH") {
      const removed = (url.searchParams.get("removeParents") ?? "").split(",").filter(Boolean);
      const kept = (parents.get(fileId) ?? ["shared-folder-1"]).filter((id) => !removed.includes(id));
      parents.set(fileId, [...new Set([...kept, url.searchParams.get("addParents")])]);
      return Response.json({ id: fileId, webViewLink: "https://drive.google.com/file/d/" + fileId, parents: parents.get(fileId) });
    }
    return new Response("unexpected", { status: 500 });
  };
  return { fetchImpl, calls, parents };
}

test("Drive upload: JWT grant, then a multipart upload into the routed folder", async () => {
  const { info, publicKey, json } = serviceAccount();
  const { fetchImpl, calls } = fakeDrive(info, { existingFolders: { "Needs-Review": "review-folder-7" } });
  const storage = new GoogleDriveStorage(json, "shared-folder-1", { fetchImpl });

  const stored = await storage.store({
    data: Buffer.from("slip-bytes"),
    filename: "สลิป.jpg",
    contentType: "image/jpeg",
    folder: "needs-review",
    ownerTag: "M3",
  });
  await storage.store({ data: Buffer.from("again"), filename: "b.jpg", contentType: "image/jpeg", folder: "needs-review" });

  assert.deepEqual(stored, {
    backend: "GoogleDriveStorage",
    ref: "file-9",
    url: "https://drive.google.com/file/d/file-9",
  });
  assert.equal(calls.filter((call) => call.url === info.token_uri).length, 1, "token is cached");
  const lookups = calls.filter((call) => call.method === "GET" && call.url.startsWith(DRIVE_FILES_URL + "?"));
  assert.equal(lookups.length, 1, "the folder id is cached after the first lookup");

  const assertion = new URLSearchParams(String(calls[0].init.body)).get("assertion");
  const [header, claims, signature] = assertion.split(".");
  assert.ok(
    crypto.verify(
      "RSA-SHA256",
      Buffer.from(header + "." + claims),
      publicKey,
      Buffer.from(signature, "base64url"),
    ),
  );
  const decodedClaims = JSON.parse(Buffer.from(claims, "base64url").toString());
  assert.equal(decodedClaims.iss, info.client_email);
  assert.equal(decodedClaims.scope, "https://www.googleapis.com/auth/drive.file");

  const uploadCall = calls.find((call) => call.url === DRIVE_UPLOAD_URL);
  assert.ok(uploadCall.url.includes("supportsAllDrives=true"));
  assert.equal(uploadCall.init.headers.Authorization, "Bearer token-123");
  const body = uploadCall.init.body.toString("utf8");
  assert.ok(body.includes("\"parents\":[\"review-folder-7\"]"), "uploaded into the Needs-Review folder");
  assert.match(body, /"name":"M3_\d{8}T\d{6}_[0-9a-f]{8}_/, "the member id leads the object name");
  assert.ok(body.includes("Content-Type: image/jpeg\r\n\r\nslip-bytes"));
});

test("Drive folders: found by name under the root, created when missing, all-drives flags set", async () => {
  const { info, json } = serviceAccount();
  const { fetchImpl, calls } = fakeDrive(info, { existingFolders: { Verified: "verified-1" } });
  const storage = new GoogleDriveStorage(json, "shared-folder-1", { fetchImpl });

  assert.equal(await storage.folderIdFor("verified"), "verified-1");
  assert.equal(await storage.folderIdFor("rejected"), "folder-new-1");
  assert.equal(await storage.folderIdFor("rejected"), "folder-new-1", "cached");

  const lookups = calls.filter((call) => call.method === "GET" && call.url.startsWith(DRIVE_FILES_URL + "?"));
  assert.equal(lookups.length, 2);
  for (const lookup of lookups) {
    const params = new URL(lookup.url).searchParams;
    assert.equal(params.get("supportsAllDrives"), "true");
    assert.equal(params.get("includeItemsFromAllDrives"), "true");
    assert.match(params.get("q"), /'shared-folder-1' in parents/);
    assert.match(params.get("q"), /mimeType = 'application\/vnd\.google-apps\.folder'/);
    assert.match(params.get("q"), /trashed = false/);
  }
  const create = calls.find((call) => call.method === "POST" && call.url.startsWith(DRIVE_FILES_URL + "?"));
  assert.ok(create.url.includes("supportsAllDrives=true"));
  assert.deepEqual(JSON.parse(create.init.body), {
    name: "Rejected",
    mimeType: "application/vnd.google-apps.folder",
    parents: ["shared-folder-1"],
  });
  await assert.rejects(storage.store({ data: Buffer.from("x"), filename: "a.jpg", contentType: "image/jpeg", folder: "../x" }));
});

test("Drive folder overrides skip the lookup entirely", async () => {
  const { info, json } = serviceAccount();
  const { fetchImpl, calls } = fakeDrive(info);
  const storage = new GoogleDriveStorage(json, "shared-folder-1", {
    fetchImpl,
    folderOverrides: { verified: "ov-v", "needs-review": "ov-r", rejected: "ov-x" },
  });
  await storage.store({ data: Buffer.from("x"), filename: "a.jpg", contentType: "image/jpeg", folder: "verified" });
  assert.equal(await storage.folderIdFor("rejected"), "ov-x");
  assert.ok(!calls.some((call) => call.url.startsWith(DRIVE_FILES_URL + "?q") || call.url.includes("?q=")));
  assert.ok(calls.find((call) => call.url === DRIVE_UPLOAD_URL).init.body.toString().includes("\"parents\":[\"ov-v\"]"));
});

test("Drive move: PATCH addParents/removeParents with supportsAllDrives, file ends in one folder", async () => {
  const { info, json } = serviceAccount();
  const { fetchImpl, calls, parents } = fakeDrive(info, {
    existingFolders: { "Needs-Review": "review-1", Verified: "verified-1", Rejected: "rejected-1" },
  });
  const storage = new GoogleDriveStorage(json, "shared-folder-1", { fetchImpl });
  const stored = await storage.store({ data: Buffer.from("x"), filename: "a.jpg", contentType: "image/jpeg", folder: "needs-review" });
  assert.deepEqual(parents.get(stored.ref), ["review-1"]);

  const moved = await storage.move(stored.ref, "verified");
  assert.deepEqual(moved, { backend: "GoogleDriveStorage", ref: stored.ref, url: stored.url });
  assert.deepEqual(parents.get(stored.ref), ["verified-1"]);

  const patch = calls.find((call) => call.method === "PATCH");
  const patchUrl = new URL(patch.url);
  assert.equal(patchUrl.pathname, "/drive/v3/files/" + stored.ref);
  assert.equal(patchUrl.searchParams.get("addParents"), "verified-1");
  assert.equal(patchUrl.searchParams.get("removeParents"), "review-1");
  assert.equal(patchUrl.searchParams.get("supportsAllDrives"), "true");
  const parentsRead = calls.find((call) => call.method === "GET" && call.url.includes("/files/" + stored.ref));
  assert.ok(parentsRead.url.includes("supportsAllDrives=true"));

  // A legacy file sitting in the root folder moves out of it too.
  parents.set("legacy-1", ["shared-folder-1"]);
  await storage.move("legacy-1", "rejected");
  assert.deepEqual(parents.get("legacy-1"), ["rejected-1"]);

  // A ref that is not a Drive id never reaches a URL.
  await assert.rejects(storage.move("../../etc", "verified"), /invalid Drive file id/);
});

test("Drive copy: files.copy into the target folder with supportsAllDrives; the original keeps its parents", async () => {
  const { info, json } = serviceAccount();
  const { fetchImpl, calls, parents } = fakeDrive(info, { existingFolders: { Rejected: "rejected-1" } });
  const storage = new GoogleDriveStorage(json, "shared-folder-1", { fetchImpl });
  parents.set("legacy-shared", ["shared-folder-1"]);

  const copy = await storage.copy("legacy-shared", "rejected", { ownerTag: "M4" });
  assert.equal(copy.backend, "GoogleDriveStorage");
  assert.notEqual(copy.ref, "legacy-shared");
  assert.equal(copy.url, "https://drive.google.com/file/d/" + copy.ref);
  assert.deepEqual(parents.get(copy.ref), ["rejected-1"]);
  assert.deepEqual(parents.get("legacy-shared"), ["shared-folder-1"], "the shared original is untouched");

  const call = calls.find((entry) => entry.method === "POST" && entry.url.includes("/copy"));
  const copyUrl = new URL(call.url);
  assert.equal(copyUrl.pathname, "/drive/v3/files/legacy-shared/copy");
  assert.equal(copyUrl.searchParams.get("supportsAllDrives"), "true");
  const body = JSON.parse(call.init.body);
  assert.deepEqual(body.parents, ["rejected-1"]);
  assert.match(body.name, /^M4_\d{8}T\d{6}_[0-9a-f]{8}_/);
  assert.ok(!calls.some((entry) => entry.method === "PATCH"), "a copy never re-parents anything");

  // Undo of a copy deletes only the copy.
  await storage.remove(copy.ref);
  const del = calls.find((entry) => entry.method === "DELETE");
  assert.equal(new URL(del.url).pathname, "/drive/v3/files/" + copy.ref);
  assert.equal(new URL(del.url).searchParams.get("supportsAllDrives"), "true");
  assert.deepEqual(parents.get("legacy-shared"), ["shared-folder-1"]);
  await assert.rejects(storage.copy("bad/../id", "rejected"), /invalid Drive file id/);
});

test("Drive move back to legacy targets the root folder (undo of a review)", async () => {
  const { info, json } = serviceAccount();
  const { fetchImpl, parents } = fakeDrive(info, { existingFolders: { Verified: "verified-1" } });
  const storage = new GoogleDriveStorage(json, "shared-folder-1", { fetchImpl });
  parents.set("old-1", ["verified-1"]);
  await storage.move("old-1", "legacy");
  assert.deepEqual(parents.get("old-1"), ["shared-folder-1"]);
});
