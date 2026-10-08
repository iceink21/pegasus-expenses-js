# Python → Node migration notes

Source of truth: `~/pegasus-expenses` (FastAPI, read-only during the port).
This file maps each Python module to its port, lists what was deliberately
kept, and lists every behaviour difference.

## 1. Module map

| Python | Node | Notes |
|---|---|---|
| `app/config.py` | `src/config.js` | `Settings()` → `loadSettings(env)`. Env is passed in explicitly, so there is no global cache and no `reset_settings_cache()` |
| `app/db.py` | `src/db/sql.js`, `src/db/connection.js` | Same schema and statements. One `node:sqlite` handle per process instead of a connection per request |
| `app/audit.py` | `src/audit.js` | `write_audit` + `write_audit_committed` → one `writeAudit` (node:sqlite autocommits outside a transaction) |
| `app/auth.py` | `src/auth.js`, `src/session.js` | itsdangerous → HMAC-SHA256 token with an issued-at timestamp; FastAPI dependencies → Express middleware `requireTeam/requireAdmin(ctx, mode)` |
| `app/permissions.py` | `src/permissions.js` | 1:1 |
| `app/decision.py` | `src/decision.js` | 1:1, plus `decisionView()` for the result page (see §3) |
| `app/providers.py` | `src/providers.js` | 1:1, same startup-note strings |
| `app/templating.py` | `public/js/copy.js` | Verdict copy, labels and `thb`/`dt` filters now run in the browser |
| `app/main.py` | `src/app.js`, `src/server.js`, `src/routes/errors.js` | Lifespan order kept: guard → DB → providers |
| `app/routers/auth_routes.py` | `src/routes/auth-routes.js` | |
| `app/routers/expenses.py` | `src/routes/expenses.js` | `parse_amount` → `parseAmount` |
| `app/routers/admin.py` | `src/routes/admin.js`, `src/csv.js` | |
| `app/extraction/base.py` | `src/extraction/base.js` | |
| `app/extraction/amount_text.py` | `src/extraction/amount-text.js` | `find_amount`→`findAmount` (returns `{amount, detail}`), `_pick`→`pickLabel`, `_lower`→`lowerSameLength` |
| `app/extraction/qr.py` | `src/extraction/qr.js`, `src/extraction/qr-decode.js` | pyzbar/OpenCV → sharp + jsQR |
| `app/extraction/vision.py` | `src/extraction/vision.js` | urllib → fetch; key still in the `X-Goog-Api-Key` header |
| `app/extraction/stub.py` | `src/extraction/stub.js` | |
| `app/extraction/pipeline.py` | `src/extraction/pipeline.js` | Stages are async |
| `app/storage/base.py`, `local.py` | `src/storage/base.js`, `local.js` | `safe_filename` moved to `base.js` (Drive uses it too) |
| `app/storage/gdrive.py` | `src/storage/gdrive.js`, `google-auth.js` | Google SDK → service-account JWT grant + Drive multipart upload over fetch; `supportsAllDrives=true` kept |
| `app/slipverify/*` | `src/slipverify/*` | Null provider only, as before |
| `templates/*.html` | `pages/*.html` + `public/js/pages/*.js` | Static shells; Thai copy copied verbatim |
| `tests/*.py` | `test/*.test.js` | Every Python test ported (see §4) |
| `scripts/run_local.sh` | `scripts/run_local.sh` (`npm run dev`) | Port 8811, host 127.0.0.1 |
| `scripts/dev_demo.py` | — | Not ported; README §1 has the curl recipe |
| `nixpacks.toml` | `Dockerfile` | No native libs needed (no libzbar, no OpenCV) |

## 2. Preserved on purpose

- **The amount parser is a faithful port, deferred gaps included.**
  `amount-text.js` keeps the algorithm, the keyword lists and their order,
  `MAX_CARRY_GAP_LINES = 2`, the warning texts, and the
  `TODO(deferred — needs real Vision OCR samples)` block word for word. The
  known wrong answer on a label column above a value column (returns 45,300.00)
  is still pinned by a test. Nothing was "improved", and no new hand-written
  fixtures were added. Python's Unicode-aware behaviour was kept: `\d` →
  `\p{Nd}`, Thai digits are folded before conversion, and `splitlines()`
  boundaries are kept.
  - Verified beyond the ported tests with a one-off differential run: 4,000
    randomized slip-like texts through both `find_amount` and `findAmount`,
    with 0 differences in amount or detail string.
- **Python number semantics.** `shared/numbers.js` reproduces `float()`
  (underscores, inf/nan, Unicode digits, strict rejection) and `round(x, 2)`
  (exact binary value, ties to even). Both were checked against CPython: 20k
  values for `round` and 24 edge strings for `float`, with 0 differences.
  `formatThb` goes through the same rounding. `Intl` would print 2.675 as
  "2.68"; Python prints "2.67".
- Verdict rule, tolerance formula, flag reasons, and that UNREADABLE is never
  flagged.
- Duplicate detection by image SHA-256, including reuse of the original evidence
  reference.
- Audit action names, row shape, and writing the row at the decision point.
- Startup guard: the same three published defaults, the same named-offender
  message, `ALLOW_INSECURE_DEFAULTS` off by default, and `COOKIE_SECURE` tied to
  it.
- `REQUIRE_REAL_PROVIDERS` / `ProviderConfigError`, and the same Drive fallback
  rules.
- `TRUSTED_PROXY_IPS` handling of `X-Forwarded-For`.
- Timestamp format `YYYY-MM-DDTHH:MM:SS+00:00`, and the UI shows that UTC clock
  time unconverted, exactly as the Jinja filter did.
- The CSV columns, the BOM and Python's csv dialect.

## 3. Behaviour differences

| Area | Python | Node | Why |
|---|---|---|---|
| Rendering | Jinja server-side HTML | Static shells; page JS fetches JSON | "Plain HTML + vanilla JS, served statically" |
| `POST /upload` response | HTML result page | JSON decision + `result_url`; the page navigates to `/result?id=&member=` | Follows from static pages |
| Result page | Only right after the POST | `/result` re-reads the stored row through the scope-checked `/api/expenses/:id`. Difference and tolerance are recomputed with the **current** epsilon settings | The page is a separate GET |
| Login failure | 401 + HTML page | 401 `{"detail":"bad_passcode"}`; the page script shows the Thai message | Same |
| Login success | 303 | 303, or `{location}` JSON when the client asks for JSON | Lets the page script navigate itself |
| Unauthenticated / non-admin access | 303 redirect, **not audited** | Pages: same 303. JSON endpoints and `POST /upload`: 401 `{detail, location}`. **Both are audited** as `access.denied` (`subject_type=route`, reason `no_team_session` / `no_admin_session`) | Task requirement: audit every deny path where it happens |
| Errors | HTML for `Accept: text/html`, JSON otherwise | Always JSON `{detail}`; the browser maps the code to Thai. Unknown URLs still get the HTML error page (404) | |
| Upload validation order | Fields → member → amount → category → empty → size | Same, except an oversize file is rejected by multer (413) before any field check | Streaming limit; avoids buffering huge bodies |
| Claimed amount `"nan"` | Accepted, then 500 on the NOT NULL insert | 400 `amount_not_a_number` | Bug fix |
| Extra file fields in the upload | Ignored | 422 `invalid_upload` (multer accepts only `slip`) | Memory safety |
| QR decoding | pyzbar (several symbols) → OpenCV fallback | jsQR, one symbol per image, after downscaling to fit 2000 px. Only JPEG/PNG/GIF/WebP bytes reach sharp | No native deps; keeps SVG/PDF parsers away from untrusted input |
| Audit `detail` JSON | `json.dumps(sort_keys)`: `", "` separators, floats as `1250.0` | Sorted keys, compact separators, `1250` | JS has no int/float distinction |
| CSV floats | `1250.0` | `1250` | Same |
| Client IP | uvicorn peer | Socket peer with `::ffff:` stripped | IPv4-mapped addresses on dual-stack sockets |
| Session cookie | itsdangerous format | Own HMAC token format | Cookies from the Python app are not valid here, which is irrelevant for a fresh deploy |
| Upload page error | Full error page | Inline Thai message above the form; the inputs are kept | Mobile re-entry is painful |
| 405 on a wrong method | Starlette 405 | 404 | Express default |

## 4. Tests

`npm test` runs every Python test translated to `node:test`. The 34
`amount_text` cases keep identical expectations. On top of the ports:

- the session-gate deny audit, and the unauthenticated upload being refused
  before its body is read
- real QR decoding: a rendered EMVCo PNG, a JPEG re-encode, a slip QR without
  tag 54, and non-raster input rejected
- the Drive upload flow against a fake fetch, with a real RSA key whose JWT
  signature is verified, token caching, `supportsAllDrives`, and the parents
  folder
- the numeric compatibility helpers, formatting filters and the CSV dialect
- logout audit, the oversize upload (413), Thai-digit claims, and the my-expenses
  API

Not covered by automated tests: rendering of the authenticated pages in a
browser. Their scripts pass `node --check`, and the shared module chain was
exercised in headless Chrome through the error page.
