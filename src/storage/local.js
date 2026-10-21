// Local disk evidence storage — the no-credentials default.
//
// On Railway/Fly this directory MUST sit on a mounted volume, or every
// redeploy wipes the evidence. In practice production should use
// GoogleDriveStorage.
//
// Layout: <directory>/verified, <directory>/needs-review, <directory>/rejected.
// Files stored before routing existed sit directly in <directory> ("legacy").

import fs from "node:fs";
import path from "node:path";

import {
  assertEvidenceFolder,
  EVIDENCE_FOLDERS,
  EvidenceFolder,
  safeFilename,
  storedEvidence,
} from "./base.js";

export class LocalDiskStorage {
  name = "LocalDiskStorage";

  constructor(directory) {
    this.directory = path.resolve(directory);
    for (const folder of EVIDENCE_FOLDERS) {
      fs.mkdirSync(path.join(this.directory, folder), { recursive: true });
    }
  }

  folderPath(folder) {
    return path.join(this.directory, assertEvidenceFolder(folder));
  }

  async store({ data, filename, contentType, folder, ownerTag = "" }) {
    const target = this.folderPath(folder);
    await fs.promises.mkdir(target, { recursive: true });
    const filePath = path.join(target, safeFilename(filename, contentType, ownerTag));
    // "wx": never overwrite, even on the (random-suffixed) name colliding.
    await fs.promises.writeFile(filePath, data, { flag: "wx" });
    return storedEvidence({ backend: this.name, ref: filePath, url: null });
  }

  /** A routed folder, or the root for "legacy" (move/undo only). */
  targetPath(folder) {
    return folder === EvidenceFolder.LEGACY ? this.directory : this.folderPath(folder);
  }

  /**
   * Resolve a stored ref and prove it is a plain file inside the upload
   * directory (a routed folder or, for legacy rows, the root). A ref is read
   * from the database, and a tampered one must not let a review rename, copy
   * or delete arbitrary files on the host.
   */
  async checkedSource(ref) {
    const source = path.resolve(String(ref ?? ""));
    const relative = path.relative(this.directory, source);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("evidence ref is outside the upload directory");
    }
    const parts = relative.split(path.sep);
    const inRoot = parts.length === 1;
    const inFolder = parts.length === 2 && EVIDENCE_FOLDERS.includes(parts[0]);
    if (!inRoot && !inFolder) throw new Error("evidence ref is not in a known folder");
    // Only a plain file: never a folder (uploads/verified is "in the root" by
    // path alone) and never a symlink that could point anywhere.
    const stat = await fs.promises.lstat(source);
    if (!stat.isFile()) throw new Error("evidence ref is not a regular file");
    return source;
  }

  /** Move a stored file into `toFolder`, keeping its name. */
  async move(ref, toFolder) {
    const target = this.targetPath(toFolder);
    const source = await this.checkedSource(ref);
    const destination = path.join(target, path.basename(source));
    if (destination === source) return storedEvidence({ backend: this.name, ref: source, url: null });
    // rename(2) silently replaces an existing destination; refuse instead.
    const exists = await fs.promises.access(destination).then(() => true, () => false);
    if (exists) throw new Error("destination already exists: " + path.basename(destination));
    await fs.promises.rename(source, destination);
    return storedEvidence({ backend: this.name, ref: destination, url: null });
  }

  /**
   * Copy a stored file into `toFolder` under a fresh collision-free name, for
   * a row whose ref is shared with other rows (legacy duplicates). The source
   * is left exactly where it is.
   */
  async copy(ref, toFolder, { ownerTag = "" } = {}) {
    const target = this.folderPath(toFolder);
    const source = await this.checkedSource(ref);
    const destination = path.join(target, safeFilename(path.basename(source), null, ownerTag));
    await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    return storedEvidence({ backend: this.name, ref: destination, url: null });
  }

  /** Delete a file this app stored (undo of a copy). Same path guards. */
  async remove(ref) {
    await fs.promises.unlink(await this.checkedSource(ref));
  }
}
