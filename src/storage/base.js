// Evidence storage interface.
//
// A storage backend is any object with
//     name: string
//     store({ data: Buffer, filename: string, contentType: string }): Promise<StoredEvidence>
// Implementations:
//   - LocalDiskStorage      (local.js)  — data/uploads/, zero credentials
//   - GoogleDriveStorage    (gdrive.js) — Shared Drive via service account

import crypto from "node:crypto";

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

/** Collision-free, path-safe object name: <utc stamp>_<8 hex>_<sanitised name>. */
export function safeFilename(filename, contentType) {
  const basename = String(filename ?? "").split("/").pop();
  let base = basename.replace(SAFE_NAME, "_").replace(/^[._]+|[._]+$/g, "") || "slip";
  if (!base.includes(".")) base += EXTENSION_BY_TYPE[contentType] ?? ".bin";
  const random = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  return utcStamp() + "_" + random + "_" + base.slice(-60);
}
