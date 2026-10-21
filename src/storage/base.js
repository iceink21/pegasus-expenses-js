// Evidence storage interface.
//
// A storage backend is any object with
//     name: string
//     store({ data, filename, contentType, folder, ownerTag }): Promise<StoredEvidence>
//     move(ref, toFolder): Promise<StoredEvidence>
//     copy(ref, toFolder, { ownerTag }): Promise<StoredEvidence>   (new, separate file)
//     remove(ref): Promise<void>                                   (undo of a copy)
// move() also accepts "legacy" (= the root), used only to undo a review that
// moved a pre-routing file out of the root.
// `folder` is one of EVIDENCE_FOLDERS and is chosen by the server (decision.js),
// never by a request field. Folders are flat: no per-member subfolders; the
// member is identified by `ownerTag` in the object name instead.
// Implementations:
//   - LocalDiskStorage      (local.js)  — data/uploads/, zero credentials
//   - GoogleDriveStorage    (gdrive.js) — Shared Drive via service account

import crypto from "node:crypto";

/** The three folders evidence is routed into. "legacy" rows predate routing. */
export const EvidenceFolder = Object.freeze({
  VERIFIED: "verified",
  NEEDS_REVIEW: "needs-review",
  REJECTED: "rejected",
  LEGACY: "legacy",
});

export const EVIDENCE_FOLDERS = Object.freeze([
  EvidenceFolder.VERIFIED,
  EvidenceFolder.NEEDS_REVIEW,
  EvidenceFolder.REJECTED,
]);

/** Throws unless `folder` is one a file may be stored in or moved to. */
export function assertEvidenceFolder(folder) {
  if (!EVIDENCE_FOLDERS.includes(folder)) {
    throw new Error("unknown evidence folder: " + JSON.stringify(folder));
  }
  return folder;
}

/** backend name, opaque ref (file path or Drive file id), optional URL. */
export function storedEvidence({ backend, ref, url = null }) {
  return Object.freeze({ backend, ref, url });
}

const SAFE_NAME = /[^A-Za-z0-9._-]+/g;
const EXTENSION_BY_TYPE = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/heic": ".heic",
};

// strftime("%Y%m%dT%H%M%S") in UTC.
function utcStamp(date = new Date()) {
  return date.toISOString().slice(0, 19).replaceAll("-", "").replaceAll(":", "");
}

/**
 * Collision-free, path-safe object name: [<owner>_]<utc stamp>_<8 hex>_<sanitised name>.
 * `ownerTag` (e.g. "M3" for member id 3) is sanitised the same way; Thai
 * display names would be stripped to nothing by SAFE_NAME, so callers pass
 * the member id rather than the name.
 */
export function safeFilename(filename, contentType, ownerTag = "") {
  const basename = String(filename ?? "").split("/").pop();
  let base = basename.replace(SAFE_NAME, "_").replace(/^[._]+|[._]+$/g, "") || "slip";
  if (!base.includes(".")) base += EXTENSION_BY_TYPE[contentType] ?? ".bin";
  const random = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const owner = String(ownerTag ?? "").replace(SAFE_NAME, "").slice(0, 20);
  return (owner ? owner + "_" : "") + utcStamp() + "_" + random + "_" + base.slice(-60);
}
