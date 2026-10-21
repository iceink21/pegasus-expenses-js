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
- Duplicate detection by image SHA-256. (Reuse of the original evidence
  reference was preserved until 2026-10-20; a duplicate now stores its own
  copy in `needs-review` — see §3.)
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
| Login failure | 401 + HTML page | 401 `{"detail":"bad_credentials"}` (same body for unknown user and wrong password); 423 `account_locked`, 403 `account_disabled`, 429 `rate_limited`; the page script shows the Thai message | Same; see "Per-member accounts" below |
| Login success | 303 | 303, or `{location}` JSON when the client asks for JSON | Lets the page script navigate itself |
| Unauthenticated / non-admin access | 303 redirect, **not audited** | No session: pages 303 `/login`, JSON 401 `{detail, location}`. A member on an admin route: pages 303 `/upload`, JSON 403 `admin_required`. **All audited** as `access.denied` (`subject_type=route`, reasons `no_session`, `invalid_session`, `unknown_account`, `account_disabled`, `session_revoked`, `role_changed`, `must_change_password`, `not_admin`) | Task requirement: audit every deny path where it happens |
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
| LLM amount extraction | — | Optional OpenRouter stage (`src/extraction/llm.js`): primary when Vision is absent, fallback after Vision otherwise. Adds `extraction_source = "llm"` and an `extractor` key in the audit detail. Verdict logic unchanged | Post-port addition (2026-10-08); not in the Python app |
| Verdict visibility | Shown to the submitter | Member sessions get only `{status:"received", expense:{id, created_at, member_name, category, note, claimed_amount}}` from `POST /upload`, `/api/expenses/:id` and `/api/my` (allow-list in `src/views.js`); the result page shows one neutral Thai confirmation. Verdict, flags, duplicates and extraction are still stored and audited, and stay fully visible to admin | Post-port change (2026-10-08): the submitter should not learn whether the bill passed |
| Member identity | Name picked per upload from `TEAM_MEMBERS`; `?member=` label on reads | Name typed at login, normalized, matched case-insensitively against a `members` table (created when new, audited `member.created`); its id is sealed in the session and used for uploads, "my expenses" and the scope check. `TEAM_MEMBERS` is no longer read; `?member=` and a member's `member_name` upload field are ignored. Admin uploads take a typed `member_name`. `result_url` is `/result?id=` | Post-port change (2026-10-08) |
| Schema | `expenses.member_name` only | New `members` table (UNIQUE `name_key`) and `expenses.member_id` (last column). `src/db/migrate.js` runs at every startup in one `BEGIN IMMEDIATE` transaction: adds the column/index if missing and links unlinked rows by their stored name. A no-op once applied. `member_name` is kept on each row unchanged | Post-port change (2026-10-08) |
| Old sessions | — | Superseded by the session v2 row below | |
| Per-member accounts | Shared team passcode + admin password | Every member is an account (`members.username`, scrypt `password_hash`, `role`, lockout and session-version columns appended to `members`; migration gives existing members placeholder usernames `member<id>` and no password). One `POST /login` (username + password or a one-time setup code); admins are accounts with role `admin`, the first one bootstrapped from `ADMIN_PASSWORD` when none exists. `TEAM_PASSCODE` is retired, `/admin/login` redirects to `/login`. Login never creates a member; an admin upload picks an existing member by `member_id`. Per-IP rate limit (client IP from `CLIENT_IP_HEADER` or the rightmost `X-Forwarded-For` entry of a trusted proxy — the Python/earlier port took the leftmost, which the client controls), per-account lockout, CSRF origin check on every POST, logout is a POST. New audit actions `auth.login.success/failure`, `auth.lockout`, `auth.password.changed/reset_issued`, `member.account_created/disabled/enabled/unlocked/role_changed/renamed/username_changed` (old `auth.team_login.*` / `auth.admin_login.*` rows stay in old databases) | Post-port change (2026-10-20): the passcode let anyone log in as anyone |
| Session cookie v2 | — | Payload `{uid, role, sv}` with a new HMAC salt, so every earlier cookie is invalid. Named `__Host-pegasus_session` when Secure. The gate reloads the account per request and rejects a changed `session_version` or role, which is how logout/password change/reset/disable/role change revoke sessions | Post-port change (2026-10-20) |
| Evidence routing + review | One flat upload folder; evidence stored before extraction; a duplicate reused the original's file | Evidence is stored AFTER the verdict, into `verified` (MATCH, no flag) or `needs-review` (everything else), named `M<member id>_<stamp>_<rand>_<name>`. A duplicate gets its own copy in `needs-review` (`duplicate_of_id` and `expense.duplicate_hash` unchanged). New columns `review_status, evidence_folder, approved_amount, reviewed_by, reviewed_at, review_note` (appended after `member_id`; migration backfills old rows as `verified`/`pending` with folder `legacy`, files not moved). `POST /api/admin/expenses/:id/review` approves (with `approved_amount`) or rejects a pending row, moving the file; `/admin/totals.xlsx` (exceljs 4.4.0) exports per-member totals and every row | Post-port change (2026-10-20) |
| Legacy duplicates in review | — | Rows stored before 2026-10-20 that were duplicates still share their original's file (same `evidence_backend` + `evidence_ref`), and the migration marks them `pending`. Reviewing such a row never moves the shared file: it gets its own COPY in the target folder (local `copyFile` with the same path guards, no overwrite; Drive `files.copy` with `parents=[target]`, `supportsAllDrives=true`), the other rows keep their ref, and the audit detail records `copied_shared_evidence: true` and `shared_with_ids`. If the review transaction then fails, the copy is deleted (or a moved file moved back) and `expense.review.tx_failed` is audited; a lost race is audited as `expense.review.conflict` | Post-port change (2026-10-20), found by QC |
| CSV formula cells | — | Text columns (`member_name`, `category`, `note`, `flag_reason`, `review_note`, `reviewed_by`) starting with `= + - @`, tab or CR get a leading `'` (OWASP CSV injection); numeric columns are untouched | Post-port change (2026-10-20) |
| `.env` loading | — | `npm start` / `npm run dev` pass `--env-file-if-exists=.env`; the Docker `CMD` does not | Local keys without a dotenv dependency |

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
- member privacy (`test/member-privacy.test.js`): for MATCH, MISMATCH,
  UNREADABLE and duplicate uploads, every JSON body a team session can get
  carries no verdict key or word and not the extracted amount; the admin still
  sees verdict, flags, dashboard, CSV and audit
- member names (`test/members.test.js`): normalization, validation, case /
  whitespace / NFC / zero-width variants being one name at account creation,
  simultaneous creates of one username → one account, and 6 worker threads on
  separate connections racing one new name → one row
- accounts (`test/accounts.test.js`): scrypt format and verification, the
  dummy-hash path (identical 401 bodies), setup-code flow and the forced
  change, password policy, lockout trip/doubling/cap/expiry/unlock, the per-IP
  rate limit, revocation by password change/logout/disable/role change, CSRF,
  last-admin protection, the bootstrap admin, the recovery CLI, a member
  refused on every admin route found in the router, and a grep that no
  password or setup code reaches the audit log or the server log
- the migration (`test/migration.test.js`) from the verbatim legacy schema and
  from the live members schema (placeholder usernames, no credential, links
  intact), re-run idempotence, and that fresh and migrated tables (expenses and
  members) have the same layout
- evidence routing and review (`test/evidence-review.test.js`): the five
  routing outcomes with the file checked on disk, duplicates getting their own
  copy, local-move path guards, approve/reject/409/400/502 paths with their
  audit rows, a three-way review race, member refusal on review and xlsx, the
  totals arithmetic, and the xlsx parsed back against the SQL aggregate; Drive
  folder find-or-create, overrides and move (`addParents`/`removeParents`,
  `supportsAllDrives`) against a fake fetch (`test/qr-and-drive.test.js`)
- the LLM extractor against a fake fetch (`test/llm-extraction.test.js`):
  success, malformed JSON, timeout, 401, 429 retry, network retry, null amount,
  prompt-injection text, absurd/non-positive amounts, low confidence, pipeline
  fallback order, provider selection, and an upload end to end

Not covered by automated tests: rendering of the authenticated pages in a
browser. Their scripts pass `node --check`, and the shared module chain was
exercised in headless Chrome through the error page.
