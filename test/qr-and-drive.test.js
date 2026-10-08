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
import { DRIVE_UPLOAD_URL, GoogleDriveStorage } from "../src/storage/gdrive.js";
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

test("Drive upload: JWT grant, then a multipart upload into the Shared Drive folder", async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const info = {
    client_email: "svc@pegasus.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    token_uri: "https://oauth2.googleapis.com/token",
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url) === info.token_uri) {
      return Response.json({ access_token: "token-123", expires_in: 3600 });
    }
    return Response.json({ id: "file-9", webViewLink: "https://drive.google.com/file/d/file-9" });
  };
  const storage = new GoogleDriveStorage(
    Buffer.from(JSON.stringify(info)).toString("base64"),
    "shared-folder-1",
    { fetchImpl },
  );

  const stored = await storage.store({
    data: Buffer.from("slip-bytes"),
    filename: "สลิป.jpg",
    contentType: "image/jpeg",
  });
  await storage.store({ data: Buffer.from("again"), filename: "b.jpg", contentType: "image/jpeg" });

  assert.deepEqual(stored, {
    backend: "GoogleDriveStorage",
    ref: "file-9",
    url: "https://drive.google.com/file/d/file-9",
  });
  assert.equal(calls.filter((call) => call.url === info.token_uri).length, 1, "token is cached");

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

  const uploadCall = calls[1];
  assert.equal(uploadCall.url, DRIVE_UPLOAD_URL);
  assert.ok(uploadCall.url.includes("supportsAllDrives=true"));
  assert.equal(uploadCall.init.headers.Authorization, "Bearer token-123");
  const body = uploadCall.init.body.toString("utf8");
  assert.ok(body.includes("\"parents\":[\"shared-folder-1\"]"));
  assert.ok(body.includes("Content-Type: image/jpeg\r\n\r\nslip-bytes"));
});
