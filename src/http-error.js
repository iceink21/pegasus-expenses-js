// An HTTP failure with a machine-readable `detail` code. The error handler
// turns it into `{ "detail": <code> }`; the browser maps the code to Thai copy
// (public/js/copy.js), so the server never ships UI wording in error bodies.

export class HttpError extends Error {
  constructor(status, detail, extra = {}) {
    super(detail);
    this.name = "HttpError";
    this.status = status;
    this.detail = detail;
    this.extra = extra;
  }
}
