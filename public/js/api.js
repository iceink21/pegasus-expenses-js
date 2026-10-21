// JSON calls to the server. A 401 that names a login page navigates there (the
// session expired, was revoked, or never existed), and so does a 403 asking for
// a password change first; every other failure becomes an ApiError carrying
// the server's detail code for copy.js to translate.

export class ApiError extends Error {
  constructor(status, detail) {
    super(detail || "HTTP " + status);
    this.status = status;
    this.detail = detail;
  }
}

async function handle(response) {
  const body = await response.json().catch(() => ({}));
  const redirect =
    (response.status === 401 || (response.status === 403 && body.detail === "password_change_required")) &&
    body.location;
  if (redirect) {
    window.location.assign(body.location);
    // The page is navigating away; leave the caller waiting rather than
    // flashing an error over a page that is about to disappear.
    return new Promise(() => {});
  }
  if (!response.ok) throw new ApiError(response.status, body.detail);
  return body;
}

export async function getJson(url) {
  return handle(await fetch(url, { headers: { accept: "application/json" } }));
}

/** POST a URLSearchParams or FormData body and read the JSON answer. */
export async function postForm(url, body) {
  return handle(await fetch(url, { method: "POST", body, headers: { accept: "application/json" } }));
}

/** POST a JSON body and read the JSON answer. */
export async function postJson(url, payload) {
  return handle(
    await fetch(url, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { accept: "application/json", "content-type": "application/json" },
    }),
  );
}
