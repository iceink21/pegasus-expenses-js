// Local disk evidence storage — the no-credentials default.
//
// On Railway this directory MUST sit on a mounted Volume, or every redeploy
// wipes the evidence. In practice production should use GoogleDriveStorage.

import fs from "node:fs";
import path from "node:path";

import { safeFilename, storedEvidence } from "./base.js";

export class LocalDiskStorage {
  name = "LocalDiskStorage";

  constructor(directory) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true });
  }

  async store({ data, filename, contentType }) {
    await fs.promises.mkdir(this.directory, { recursive: true });
    const filePath = path.join(this.directory, safeFilename(filename, contentType));
    await fs.promises.writeFile(filePath, data);
    return storedEvidence({ backend: this.name, ref: path.resolve(filePath), url: null });
  }
}
