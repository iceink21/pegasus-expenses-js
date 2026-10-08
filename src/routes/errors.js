// 404 fallback and the single error handler.
//
// Every non-page response is JSON `{ "detail": <code> }`. The browser scripts
// map the code to Thai copy (public/js/copy.js); a person who opens an unknown
// URL gets the static error page instead.

import multer from "multer";

import { HttpError } from "../http-error.js";
import { createLogger } from "../log.js";
import { sendPage } from "./http.js";

const logger = createLogger("pegasus");

export function notFound(req, res) {
  res.status(404);
  if (!req.path.startsWith("/api/") && (req.get("accept") ?? "").includes("text/html")) {
    sendPage(res, "error.html");
    return;
  }
  res.json({ detail: "Not Found" });
}

// Express recognises an error handler by its four-argument signature, so
// `next` stays in the parameter list even though it is never called.
export function errorHandler(error, req, res, next) {
  if (error instanceof HttpError) {
    res.status(error.status).json({ detail: error.detail, ...error.extra });
    return;
  }
  if (error instanceof multer.MulterError) {
    const tooLarge = error.code === "LIMIT_FILE_SIZE";
    res.status(tooLarge ? 413 : 422).json({ detail: tooLarge ? "file_too_large" : "invalid_upload" });
    return;
  }
  // body-parser / static errors carry their own 4xx status.
  if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
    res.status(error.status).json({ detail: error.expose ? error.message : "bad_request" });
    return;
  }
  logger.error("unhandled error on " + req.method + " " + req.path, error);
  res.status(500).json({ detail: "internal_error" });
}
