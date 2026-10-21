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
//
// Evidence is routed into three subfolders of GDRIVE_FOLDER_ID: Verified,
// Needs-Review and Rejected. By default they are found or created on first
// use (folders this app created stay visible under the drive.file scope) and
// their ids cached; GDRIVE_FOLDER_VERIFIED / _REVIEW / _REJECTED override them
// with existing folder ids.

import crypto from "node:crypto";

import { assertEvidenceFolder, EvidenceFolder, safeFilename, storedEvidence } from "./base.js";
import { ServiceAccountTokenSource } from "./google-auth.js";

export const DRIVE_SCOPES = Object.freeze(["https://www.googleapis.com/auth/drive.file"]);
export const DRIVE_UPLOAD_URL =
  "https://www.googleapis.com/upload/drive/v3/files" +
  "?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink";

export const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

/** Drive folder names for each routed folder. */
export const DRIVE_FOLDER_NAMES = Object.freeze({
  [EvidenceFolder.VERIFIED]: "Verified",
  [EvidenceFolder.NEEDS_REVIEW]: "Needs-Review",
  [EvidenceFolder.REJECTED]: "Rejected",
});

// Drive ids are URL-safe base64-ish; refuse anything else before it reaches a
// URL path or a query string.
const DRIVE_ID = /^[A-Za-z0-9_-]{1,200}$/;

function assertDriveId(value, what) {
  if (!DRIVE_ID.test(String(value ?? ""))) throw new Error("invalid Drive " + what + " id");
  return String(value);
}

/** Quote a value for a Drive `q` expression. */
function driveQuote(value) {
  return "'" + String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'") + "'";
}

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

  /**
   * `folderOverrides` maps a routed folder ("verified" | "needs-review" |
   * "rejected") to an existing Drive folder id; missing entries are found or
   * created under `folderId` on first use.
   */
  constructor(serviceAccountJson, folderId, { fetchImpl = fetch, folderOverrides = {} } = {}) {
    if (!folderId) throw new Error("GDRIVE_FOLDER_ID is required for GoogleDriveStorage");
    this.folderId = assertDriveId(folderId, "root folder");
    this.fetchImpl = fetchImpl;
    this.folderIds = new Map();
    for (const [folder, id] of Object.entries(folderOverrides)) {
      if (id) this.folderIds.set(assertEvidenceFolder(folder), Promise.resolve(assertDriveId(id, folder + " folder")));
    }
    this.tokens = new ServiceAccountTokenSource(
      loadServiceAccountInfo(serviceAccountJson),
      DRIVE_SCOPES,
      fetchImpl,
    );
  }

  async authHeaders(extra = {}) {
    return { Authorization: "Bearer " + (await this.tokens.accessToken()), ...extra };
  }

  /** Drive folder id for a routed folder; found or created once, then cached. */
  folderIdFor(folder) {
    assertEvidenceFolder(folder);
    let pending = this.folderIds.get(folder);
    if (!pending) {
      pending = this.findOrCreateFolder(DRIVE_FOLDER_NAMES[folder]);
      this.folderIds.set(folder, pending);
      // A failed lookup must not be cached forever; the next call retries.
      pending.catch(() => {
        if (this.folderIds.get(folder) === pending) this.folderIds.delete(folder);
      });
    }
    return pending;
  }

  async findOrCreateFolder(name) {
    const q =
      "name = " + driveQuote(name) +
      " and " + driveQuote(this.folderId) + " in parents" +
      " and mimeType = " + driveQuote(DRIVE_FOLDER_MIME) +
      " and trashed = false";
    const params = new URLSearchParams({
      q,
      fields: "files(id,name)",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      pageSize: "10",
    });
    const found = await this.fetchImpl(DRIVE_FILES_URL + "?" + params, { headers: await this.authHeaders() });
    if (!found.ok) throw new Error("Drive folder lookup failed: HTTP " + found.status);
    const existing = (await found.json()).files ?? [];
    if (existing.length > 0) return assertDriveId(existing[0].id, name + " folder");

    const created = await this.fetchImpl(DRIVE_FILES_URL + "?supportsAllDrives=true&fields=id", {
      method: "POST",
      headers: await this.authHeaders({ "Content-Type": "application/json; charset=UTF-8" }),
      body: JSON.stringify({ name, mimeType: DRIVE_FOLDER_MIME, parents: [this.folderId] }),
    });
    if (!created.ok) throw new Error("Drive folder create failed: HTTP " + created.status);
    return assertDriveId((await created.json()).id, name + " folder");
  }

  async store({ data, filename, contentType, folder, ownerTag = "" }) {
    const parent = await this.folderIdFor(folder);
    const mediaType = contentType || "application/octet-stream";
    const metadata = { name: safeFilename(filename, contentType, ownerTag), parents: [parent] };
    const upload = multipartRelated(metadata, data, mediaType);
    const response = await this.fetchImpl(DRIVE_UPLOAD_URL, {
      method: "POST",
      headers: await this.authHeaders({ "Content-Type": upload.contentType }),
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

  /**
   * Re-parent a file into `toFolder`. The current parents are read first and
   * all of them removed, so the file ends up in exactly one folder even when
   * it started in the root (legacy rows) or a concurrent move got there first.
   */
  /** Drive folder id for a target; "legacy" is the root folder (undo only). */
  async targetIdFor(folder) {
    return folder === EvidenceFolder.LEGACY ? this.folderId : this.folderIdFor(folder);
  }

  async move(ref, toFolder) {
    const fileId = assertDriveId(ref, "file");
    const target = await this.targetIdFor(toFolder);
    const fileUrl = DRIVE_FILES_URL + "/" + fileId;

    const current = await this.fetchImpl(fileUrl + "?supportsAllDrives=true&fields=id,parents", {
      headers: await this.authHeaders(),
    });
    if (!current.ok) throw new Error("Drive file lookup failed: HTTP " + current.status);
    const parents = ((await current.json()).parents ?? []).filter((id) => id !== target);

    const params = new URLSearchParams({
      addParents: target,
      supportsAllDrives: "true",
      fields: "id,webViewLink,parents",
    });
    if (parents.length > 0) params.set("removeParents", parents.join(","));
    const response = await this.fetchImpl(fileUrl + "?" + params, {
      method: "PATCH",
      headers: await this.authHeaders({ "Content-Type": "application/json; charset=UTF-8" }),
      body: "{}",
    });
    if (!response.ok) throw new Error("Drive move failed: HTTP " + response.status);
    const moved = await response.json();
    return storedEvidence({
      backend: this.name,
      ref: String(moved.id ?? fileId),
      url: moved.webViewLink ?? null,
    });
  }

  /**
   * files.copy into `toFolder`: a separate file for a row whose ref is shared
   * with other rows (legacy duplicates). The original keeps its parents.
   */
  async copy(ref, toFolder, { ownerTag = "" } = {}) {
    const fileId = assertDriveId(ref, "file");
    const target = await this.folderIdFor(toFolder);
    const params = new URLSearchParams({ supportsAllDrives: "true", fields: "id,webViewLink" });
    const response = await this.fetchImpl(DRIVE_FILES_URL + "/" + fileId + "/copy?" + params, {
      method: "POST",
      headers: await this.authHeaders({ "Content-Type": "application/json; charset=UTF-8" }),
      body: JSON.stringify({
        name: safeFilename("evidence-copy-of-" + fileId, "image/jpeg", ownerTag),
        parents: [target],
      }),
    });
    if (!response.ok) throw new Error("Drive copy failed: HTTP " + response.status);
    const created = await response.json();
    return storedEvidence({
      backend: this.name,
      ref: assertDriveId(created.id, "copied file"),
      url: created.webViewLink ?? null,
    });
  }

  /** Delete a file this app created (undo of a copy). */
  async remove(ref) {
    const fileId = assertDriveId(ref, "file");
    const response = await this.fetchImpl(DRIVE_FILES_URL + "/" + fileId + "?supportsAllDrives=true", {
      method: "DELETE",
      headers: await this.authHeaders(),
    });
    if (!response.ok && response.status !== 404) throw new Error("Drive delete failed: HTTP " + response.status);
  }
}
