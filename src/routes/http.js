// Small helpers shared by the routers.

import { fileURLToPath } from "node:url";

import { HttpError } from "../http-error.js";
import { PermissionDenied } from "../permissions.js";

const PAGES_DIR = fileURLToPath(new URL("../../pages/", import.meta.url));

/** Serve a static page shell; its script fetches the data it shows. */
export function sendPage(res, name) {
  res.sendFile(name, { root: PAGES_DIR, headers: { "Cache-Control": "no-store" } });
}

export function wantsJson(req) {
  return (req.get("accept") ?? "").includes("application/json");
}

/** Run a permission/scope check; an audited denial becomes HTTP 403. */
export function enforce(check) {
  try {
    check();
  } catch (error) {
    if (error instanceof PermissionDenied) throw new HttpError(403, error.reason);
    throw error;
  }
}

/** A query-string value as a single string ("" when absent or repeated). */
export function queryString(req, name) {
  const value = req.query[name];
  return typeof value === "string" ? value : "";
}

/**
 * A required form field. FastAPI's Form(...) treats a missing or empty value
 * as a validation failure (422) before the handler runs; this keeps that.
 */
export function requiredField(body, name) {
  const value = body?.[name];
  if (typeof value !== "string" || value === "") {
    throw new HttpError(422, "missing_field", { field: name });
  }
  return value;
}
