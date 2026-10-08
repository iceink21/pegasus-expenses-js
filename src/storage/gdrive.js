// Google Drive Shared Drive storage via a service account.
//
// Credentials come from the GDRIVE_SA_JSON env var holding the raw
// service-account JSON (base64 also accepted, since Railway's UI mangles
// multi-line values). A credential FILE is never read from the repo, and
// .gitignore covers the usual names anyway.
//
// The target folder must live in a SHARED DRIVE, not the service account's own
// My Drive: a service account has no storage quota of its own, so uploading to
// My Drive fails with a quota error. supportsAllDrives=true is required on
// every call.

import crypto from "node:crypto";

import { safeFilename, storedEvidence } from "./base.js";
import { ServiceAccountTokenSource } from "./google-auth.js";

export const DRIVE_SCOPES = Object.freeze(["https://www.googleapis.com/auth/drive.file"]);
export const DRIVE_UPLOAD_URL =
  "https://www.googleapis.com/upload/drive/v3/files" +
  "?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink";

const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Accept either raw JSON or base64-encoded JSON. Throws on anything else. */
export function loadServiceAccountInfo(raw) {
  let text = String(raw ?? "").trim();
  if (!text) throw new Error("GDRIVE_SA_JSON is empty");
  if (!text.startsWith("{")) {
    try {
      if (!STRICT_BASE64.test(text)) throw new Error("not base64");
      text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(text, "base64"));
    } catch {
      throw new Error("GDRIVE_SA_JSON is neither JSON nor base64 JSON");
    }
  }
  let info;
  try {
    info = JSON.parse(text);
  } catch (error) {
    throw new Error("GDRIVE_SA_JSON is not valid JSON: " + error.message);
  }
  if (!info || typeof info !== "object" || Array.isArray(info) || !("client_email" in info)) {
    throw new Error("GDRIVE_SA_JSON does not look like a service-account key");
  }
  return info;
}

function multipartRelated(metadata, data, contentType) {
  const boundary = "pegasus-" + crypto.randomUUID();
  const body = Buffer.concat([
    Buffer.from(
      "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" +
        JSON.stringify(metadata) + "\r\n--" + boundary + "\r\nContent-Type: " + contentType + "\r\n\r\n",
    ),
    data,
    Buffer.from("\r\n--" + boundary + "--\r\n"),
  ]);
  return { body, contentType: "multipart/related; boundary=" + boundary };
}

export class GoogleDriveStorage {
  name = "GoogleDriveStorage";

  constructor(serviceAccountJson, folderId, { fetchImpl = fetch } = {}) {
    if (!folderId) throw new Error("GDRIVE_FOLDER_ID is required for GoogleDriveStorage");
    this.folderId = folderId;
    this.fetchImpl = fetchImpl;
    this.tokens = new ServiceAccountTokenSource(
      loadServiceAccountInfo(serviceAccountJson),
      DRIVE_SCOPES,
      fetchImpl,
    );
  }

  async store({ data, filename, contentType }) {
    const mediaType = contentType || "application/octet-stream";
    const metadata = { name: safeFilename(filename, contentType), parents: [this.folderId] };
    const upload = multipartRelated(metadata, data, mediaType);
    const response = await this.fetchImpl(DRIVE_UPLOAD_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + (await this.tokens.accessToken()),
        "Content-Type": upload.contentType,
      },
      body: upload.body,
    });
    if (!response.ok) throw new Error("Drive upload failed: HTTP " + response.status);
    const created = await response.json();
    return storedEvidence({
      backend: this.name,
      ref: String(created.id ?? ""),
      url: created.webViewLink ?? null,
    });
  }
}
