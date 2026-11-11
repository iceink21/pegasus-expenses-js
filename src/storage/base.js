// Evidence storage interface.
//
// A storage backend is any object with
//     name: string
//     store({ data, filename, contentType, folder, ownerTag, member }): Promise<StoredEvidence>
//     move(ref, toFolder): Promise<StoredEvidence>
//     copy(ref, toFolder, { ownerTag, member }): Promise<StoredEvidence>   (new, separate file)
//     remove(ref): Promise<void>                                           (undo of a copy)
// move() also accepts "legacy" (= the root), used only to undo a review that
// moved a pre-routing file out of the root.
// `folder` is one of EVIDENCE_FOLDERS and is chosen by the server (decision.js),
// never by a request field.
//
// Layouts. Two coexist and both stay fully supported:
//   - member layout (new uploads): <memberFolder>/<verdict>/<file>, where
//     memberFolder = memberFolderName(member) e.g. "สมชาย_M3". Chosen when
//     store()/copy() receive `member` ({ memberId, memberName }, looked up
//     server-side from the members table, never from a request field).
//   - flat layout (rows stored before 2026-11): <verdict>/<file>, or the root
//     for pre-routing files. No migration: these rows keep working as before.
// move() needs no member: the layout is carried by the ref itself (a file path
// or a Drive file's parents), so a member-layout file changes verdict inside
// its own member folder and a flat file moves between the flat folders.
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

const MEMBER_NAME_MAX_CHARS = 40;
const HOSTILE_NAME_CHARS = /[\\/:*?"<>|]/g;
const MEMBER_FOLDER = /^(?:.*_)?M[0-9]+$/;

/**
 * Folder name for a member: "<sanitised display name>_M<id>", or "M<id>" when
 * the name sanitises to nothing. The "_M<id>" suffix is the stable identity:
 * names can change or collide, ids cannot. Thai/Unicode letters are kept
 * (NFC); path separators, "..", control/format chars and filesystem-hostile
 * characters are removed, whitespace becomes "_", leading dots are trimmed and
 * the name part is capped at 40 characters.
 */
export function memberFolderName({ memberId, memberName = "" } = {}) {
  const id = Number(memberId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("invalid member id for evidence folder");
  let name = String(memberName ?? "")
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(HOSTILE_NAME_CHARS, "")
    .replace(/\.{2,}/g, "")
    .replace(/\s+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[._]+/, "");
  name = Array.from(name).slice(0, MEMBER_NAME_MAX_CHARS).join("").replace(/[._]+$/, "");
  return name ? name + "_M" + id : "M" + id;
}

/** True for a string memberFolderName() could have produced (read-side guard for refs). */
export function isMemberFolderName(value) {
  const name = String(value ?? "");
  return (
    name.length > 0 &&
    name.length <= 400 &&
    MEMBER_FOLDER.test(name) &&
    !/[\\/\0]/.test(name) &&
    !name.includes("..") &&
    !EVIDENCE_FOLDERS.includes(name)
  );
}
