# Pegasus Expense Tracker (Node.js)

บันทึกค่าใช้จ่ายของทีม Pegasus UAV (AAVC 2026) — สมาชิกอัปโหลดรูปสลิปจากมือถือ
พร้อมกรอกยอดที่จ่ายจริง เซิร์ฟเวอร์อ่านยอดจากรูปแล้วตัดสินเองว่า
**MATCH / MISMATCH / UNREADABLE** หัวหน้าทีมจึงไม่ต้องไล่เช็กสลิปทีละใบ

This is the Node.js port of `~/pegasus-expenses` (FastAPI). The stack is
Express 5, SQLite through the built-in `node:sqlite`, and plain HTML/CSS/JS
served from the same origin with no build step. The UI is Thai and
mobile-first. Every feature runs locally without credentials. For what changed
in the port, see [`docs/MIGRATION.md`](docs/MIGRATION.md).

---

## 1. Run locally (zero credentials)

Requires Node **22.13 or newer** (verified on 26.4). Nothing compiles at install
time: SQLite is built into Node, and `sharp` ships a prebuilt libvips.

```bash
cd ~/pegasus-expenses-js
npm install
npm run dev
# -> http://127.0.0.1:8811/   first login: username admin, password admin-dev-password
```

On a fresh `./data/pegasus.db` the first start creates the admin account
(username `admin`) from `ADMIN_PASSWORD` (the dev script sets
`admin-dev-password`). Log in with it, set your own password when asked, then
add members on **สมาชิก** (`/admin/members`): each new account comes with a
one-time setup code that its owner types as the password at `/login`, after
which they choose their own password. A database that already has an admin
ignores `ADMIN_PASSWORD`; if you are locked out locally, run
`npm run admin:reset -- admin` to print a fresh setup code.

`npm run dev` runs `scripts/run_local.sh`. That script fills in dev defaults,
binds to `127.0.0.1`, and restarts on source changes (`node --watch`). Override
any setting through the environment, e.g. `PORT=9000 npm run dev`. The default
port is 8811 because 8000 is taken by Apache on the dev Mac.

Both `npm run dev` and `npm start` load `./.env` when it exists
(`node --env-file-if-exists`, no dotenv). `.env` is gitignored and holds only
optional keys such as `OPENROUTER_API_KEY`. Shell variables win over `.env`, so
`OPENROUTER_API_KEY= npm run dev` runs one session on the stub again (the
marker recipe below needs the stub: the LLM stage only reads real images).

Tests (built-in `node:test`, no test framework dependency):

```bash
npm test
```

### Triggering the MISMATCH path by hand

The stub OCR reads markers from the uploaded bytes, so a "slip" can be a plain
text file:

```bash
printf 'PEGASUS_STUB_AMOUNT=980.00\n' > /tmp/slip.jpg

# Log in as an account that has a password (e.g. the admin after its first
# password change; an admin upload goes to the admin's own name unless the
# form also sends -F "member_id=<id>").
J=/tmp/cookies.txt
curl -s -c $J -b $J --data-urlencode "username=admin" \
  --data-urlencode "password=<your password>" http://127.0.0.1:8811/login
curl -s -c $J -b $J -X POST http://127.0.0.1:8811/upload \
  -F "category=อะไหล่โดรน" \
  -F "claimed_amount=1250.00" -F "note=test" \
  -F "slip=@/tmp/slip.jpg;type=image/jpeg"
```

The claim is 1250 and the slip reads 980, so the verdict is `MISMATCH`. The
expense row is flagged, and an `expense.decision.mismatch` audit row is written.
A member's JSON response does **not** say so: it is
`{"status":"received","expense":{id, created_at, member_name, category, note, claimed_amount},"result_url":…}`
for every outcome (an admin session gets the full decision). As an admin, read
`/api/expenses/<id>` to see the verdict.
Markers:

| marker in the uploaded bytes | result |
|---|---|
| `PEGASUS_STUB_AMOUNT=980.00` | stub OCR "reads" 980.00 |
| `PEGASUS_STUB_UNREADABLE` | stub OCR finds nothing → `UNREADABLE` |
| neither | a deterministic synthetic amount derived from the image hash |

Upload the same file twice to see the duplicate-hash flag. The admin view is at
`/admin` (an admin account), the audit log at `/admin/audit`, and the JSON
behind them at `/api/admin/dashboard` and `/api/admin/audit`.

---

## 2. How a verdict is decided

```
upload ──► sha256 ──► duplicate check
                          │
       QR stage (bonus) ──┤
    OCR stage (primary) ──┤   Vision, else LLM, else stub
LLM fallback (optional) ──┘   only after Vision finds nothing
                          ▼
             src/decision.js :: recordSubmission
             ├─ verdict computed server-side
             ├─ routeFolder(verdict, flagged) ─► store evidence in that folder
             ├─ BEGIN
             ├─ expense row INSERT (review_status, evidence_folder)
             ├─ audit row(s) INSERT      ← same transaction
             └─ COMMIT
```

* **MATCH** when `|claimed − extracted| ≤ max(MATCH_EPSILON_THB, claimed × MATCH_EPSILON_PCT)`.
  Defaults: 1 THB or 0.5%. Configured in `src/config.js` and nowhere else.
* **MISMATCH**: the row is flagged for the team lead.
* **UNREADABLE**: the UI asks for a clearer photo. It is **never** flagged and
  never presented or stored as fraud.
* The browser posts only the image and the claimed amount. It cannot assert a
  verdict, and extra form fields are ignored (a test covers this).

### Evidence folders and the admin review

The verdict picks the folder, server-side:

| Outcome | Folder | `review_status` |
|---|---|---|
| MATCH, no flag | `verified` | `verified` |
| MISMATCH, UNREADABLE, any duplicate (MATCH + duplicate too) | `needs-review` | `pending` |
| admin approves a pending row | moved to `verified` | `approved` (+ `approved_amount`) |
| admin rejects a pending row | moved to `rejected` | `rejected` |

New uploads are filed per member, member first, then verdict:

```
<LOCAL_UPLOAD_DIR>/สมชาย_M3/verified|needs-review|rejected/M3_<stamp>_<rand>_<name>
Drive: <GDRIVE_FOLDER_ID>/สมชาย_M3/Verified|Needs-Review|Rejected/<file>
```

The member folder is `<display name>_M<member id>`: Thai/Unicode letters are
kept (NFC), path separators, `..`, control characters and `/ \ : * ? " < > |`
are removed, spaces become `_`, the name part is capped at 40 characters, and
if nothing is left the folder is just `M<id>`. The `_M<id>` suffix is the stable
identity; a renamed member starts a new folder, old files stay where they are.
The name comes from the members table at upload time, never from a request.
Folders are created on first use (local: `mkdir -p`; Drive: find-or-create,
cached, concurrent creations shared). A review that changes the verdict moves the
file inside the same member folder; `evidence_folder` in the database still holds
only the bare verdict.

Rows stored before this layout keep working untouched, with no migration: files
in the flat `<LOCAL_UPLOAD_DIR>/verified|needs-review|rejected` folders (Drive:
`Verified` / `Needs-Review` / `Rejected` directly under `GDRIVE_FOLDER_ID`, or
the ids in `GDRIVE_FOLDER_VERIFIED/_REVIEW/_REJECTED`, which apply to this flat
layout only) and files in the root (`evidence_folder = legacy`). A review of such
a row moves it between the flat folders as before; it is not pulled into a member
folder. A duplicate stores its own copy in the uploader's member folder. Old
duplicates may still share their original's file, and a review of one copies that
file (into the reviewed row's member folder) instead of moving it.

`POST /api/admin/expenses/:id/review` with `{decision: "approve"|"reject",
approved_amount?, note?}` reviews a `pending` row (else 409 `not_pending`).
Approve needs `approved_amount` (same rules as the upload form). The file is
moved first; then one transaction re-checks the row is still pending, writes
the review and the `expense.review.approved|rejected` audit row (claimed vs
approved amount, folders, note). `claimed_amount` and `verdict` are never
changed. If the move fails, `expense.review.move_failed` is audited, the row
stays pending, and the response is 502. If the transaction fails after the
move, the move is undone and `expense.review.tx_failed` is audited; a review
that loses a race is undone and audited as `expense.review.conflict` (409).

Totals (dashboard and `/admin/totals.xlsx`, one SQL aggregate in
`src/db/sql.js`): claimed = everything not rejected; verified = auto-verified
claims + approved amounts; pending and rejected are claimed amounts.

All async work (OCR, evidence upload) finishes *before* `BEGIN`. The block
between BEGIN and COMMIT is synchronous, so another request cannot interleave
statements with it.

### Optional LLM extraction (OpenRouter)

`src/extraction/llm.js` sends the slip image (downscaled JPEG data URL) and any
OCR text to a vision model on OpenRouter and asks for strict JSON
`{"amount": number|null, "confidence": 0..1}`. Default model:
`google/gemini-2.5-flash-lite` (override with `OPENROUTER_MODEL`).

| Keys set | OCR stage | LLM role |
|---|---|---|
| neither | `StubOCRExtractor` (synthetic) | off |
| `OPENROUTER_API_KEY` only | `LLMAmountExtractor` | primary, replaces the stub |
| both | `VisionOCRExtractor` | fallback when Vision finds no amount (gets Vision's text as a hint) |
| Vision only | `VisionOCRExtractor` | off |

The LLM supplies a number and nothing else. The verdict is still computed
in `decision.js` from config tolerance. The code reads only `amount` and
`confidence` from the reply; it rejects non-positive values, values above
`LLM_MAX_AMOUNT_THB` (default 1,000,000), and confidence below
`LLM_MIN_CONFIDENCE` (default 0.5). The prompt marks the image and OCR text as
untrusted data. Each attempt times out at 15 s, with at most one retry
(429/5xx/network only, never after a timeout) inside a 20 s ceiling. Any
failure becomes `UNREADABLE` and the upload still succeeds. The extractor label
(`llm:<model>`) is stored in `extraction_detail`, in the audit row's
`extractor` field, and `extraction_source` is `llm`. Measured on a rendered
Thai slip: ~2.5–4 s and about $0.00015 per call (1,462 prompt + 19 completion
tokens).

### QR is a bonus, not the answer

The QR on a payment *slip* (the screenshot you get **after** paying) carries a
bank code plus a transaction reference, **not** the amount. Only a *bill* QR
(EMVCo, scanned **before** paying) carries the amount, in TLV **tag 54**, and
that is rarely what gets photographed. The QR stage runs first because it is
exact and free when it hits. A miss falls straight through to OCR, which does
the real work. See `src/extraction/qr.js`.

Only JPEG, PNG, GIF and WebP bytes reach the image decoder (sharp + jsQR).
Anything else is rejected by magic number, so an uploaded SVG or PDF never
reaches librsvg or poppler.

### The audit rule

Every decision writes its audit row **at the point of the decision**. It is not
written in middleware or a response hook. Audited:

- every MATCH / MISMATCH / UNREADABLE
- every duplicate-hash hit
- every admin review (approved / rejected) and every failed evidence move
- every permission or scope denial (403)
- every request a session gate refuses (no/invalid/revoked session, disabled
  account, a member on an admin route, a session that must change its
  password first) and every cross-site POST (CSRF)
- every login attempt, success or failure with its reason (`bad_credentials`,
  `locked`, `rate_limited`, `disabled`, `csrf`), every lockout, logout,
  password change and setup code issued — never the password or the code
- every account change: created, disabled/enabled, unlocked, role, rename
- every admin view and CSV export

---

## 3. Auth model

Every person has their own account: a row in `members` with a username and a
password. The admin is a member too (role `admin`), so their own expenses
appear in totals and the Excel export like anyone else's. There is no
self-registration and no shared passcode.

- **Login** (`POST /login`, one form for everyone): username + password. The
  username is ASCII `[a-z0-9._-]{3,32}`, matched case-insensitively. The role
  on the account decides what the session may do. Unknown username and wrong
  password get the same 401 body and cost the same one scrypt verification.
- **Passwords**: `scrypt` (node:crypto, N=2^15, r=8, p=1, 16-byte salt, 64-byte
  key), stored as `scrypt$N$r$p$salt$key`, compared with `timingSafeEqual`.
  Policy: 10–128 characters, not the username, not on a short common-password
  list; no composition rules.
- **New accounts and resets**: an admin creates the account (username, display
  name, role) on `/admin/members` and gets a **one-time setup code** in that
  response only (10 characters from an unambiguous alphabet, ~49 bits, valid
  72 h, single use, stored as a scrypt hash). Its owner logs in with the
  username and the code and must then set a password; until they do, the
  session reaches only `/account/password` and logout. "Reset password" is the
  same thing: a new setup code, which clears the old password and ends every
  session of that account.
- **Sessions**: a signed cookie (HMAC-SHA256, 12 h, HttpOnly, SameSite=Lax,
  Secure in production with the `__Host-` name prefix) carrying the account id,
  role and the account's `session_version`. The server reloads the account on
  every request and refuses the cookie when the account is missing or disabled,
  or its role or session version changed. Logout (a POST), a password change or
  reset, disabling and a role change bump the version, so they end the
  account's sessions on every device at once. A password change re-issues the
  cookie for the device that made it.
- **Brute force**: at most `LOGIN_RATE_LIMIT_ATTEMPTS` (10) `POST /login` per
  client IP per `LOGIN_RATE_LIMIT_WINDOW_SECONDS` (300) → 429. Per account,
  `LOCKOUT_THRESHOLD` (5) consecutive failures lock it for
  `LOCKOUT_BASE_SECONDS` (15 min), doubling with each further lockout up to
  `LOCKOUT_MAX_SECONDS` (24 h); a successful login resets this, and an admin
  can unlock. A locked account answers 423 even to the right password.
- **CSRF**: every POST/PUT/PATCH/DELETE must come from this app's origin
  (`Origin` header, or `Sec-Fetch-Site: same-origin` when there is no Origin);
  cross-site requests get 403 and an audit row. Requests with neither header
  come from non-browser clients and pass, since those cannot carry a victim's
  cookies. The expected origin is `PUBLIC_ORIGIN` when set, else the request's
  Host (plus the scheme from `X-Forwarded-Proto` when a trusted proxy sends it).
- **Admin safety**: the last active admin cannot be disabled or demoted, and an
  admin cannot disable themself.
- **Usernames** can be changed by an admin (e.g. migrated `member<id>`
  placeholders); a change ends that account's sessions and is audited
  `member.username_changed` with the old and new name.
- **Client IP** (audit rows and the login rate limit): the socket peer, unless
  the peer is in `TRUSTED_PROXY_IPS`. From a trusted proxy it is the
  `CLIENT_IP_HEADER` value when that is set (Fly: `fly-client-ip`, which Fly's
  edge sets itself), otherwise the **rightmost** `X-Forwarded-For` entry — the
  one the proxy appended. Entries to its left come from the client and are
  ignored, so a forged `X-Forwarded-For` can neither pick an audit IP nor get a
  fresh rate-limit bucket.
- **Recovery**: `npm run admin:reset -- <username> [--promote]` (on Fly:
  `fly ssh console -C "node scripts/admin-reset.js <username>"`) prints a new
  setup code once, unlocks and re-enables the account, and audits the reset
  without the code.

### First admin (bootstrap)

On a start where the database has **no** admin account, the app creates one:
username `admin`, display name `admin` (rename it on the members page), with
`ADMIN_PASSWORD` as its password and a forced change at first login. From then
on `ADMIN_PASSWORD` is ignored (a one-line notice says so). `TEAM_PASSCODE` is
no longer read; if it is still set, startup logs a deprecation warning.

### Startup guard on default secrets

`SESSION_SECRET` and `ADMIN_PASSWORD` have defaults that are **published in
this repo**. The app **refuses to start** while `SESSION_SECRET` is at its
default, or while `ADMIN_PASSWORD` is at its default *and would be used* (no
admin exists yet). The error names the offending variables. Set
`ALLOW_INSECURE_DEFAULTS=1` to bypass it for local development (`run_local.sh`
does this for you). The same flag drives the `COOKIE_SECURE` default: cookies
are Secure unless you are explicitly in dev.

### Cutover from the shared passcode (existing database)

What happens on the first start of this version against an existing database:
every existing member keeps their id, name and every expense link, and gets a
placeholder username `member<id>` with **no password** — nobody can log in as
them until an admin issues a setup code. All old session cookies stop working
(new token format). The first admin is bootstrapped from `ADMIN_PASSWORD`.

Fly.io, in this order:

1. Make sure `ADMIN_PASSWORD` is set to a strong value you know (it becomes the
   first admin's temporary password): `fly secrets set ADMIN_PASSWORD=...`
   (skip if it is already set and you know it). Keep `SESSION_SECRET` as is.
2. Deploy. Everyone currently logged in is logged out.
3. Log in at `/login` as `admin` with `ADMIN_PASSWORD`, set your own password,
   then rename the account to your real name on `/admin/members`.
4. For each existing member on `/admin/members` (placeholder username
   `member<id>`): first click **เปลี่ยนชื่อผู้ใช้** and give them a real
   username (same rules as new accounts; 409 if taken), then click
   **ออกรหัสตั้งค่า** and send them the username and code privately. They log
   in and choose a password. Their id, name and expenses do not change.
5. Unset the retired secret: `fly secrets unset TEAM_PASSCODE`. Optionally
   `fly secrets unset ADMIN_PASSWORD` too — it is never read again once an
   admin exists.

What members experience: the next visit shows a username/password form instead
of name + team passcode; until the admin sends their setup code they cannot log
in; after the code they set a password once and carry on as before, seeing the
same expenses.

### Members never see the verdict

A team session is never told whether a bill checked out. Every member-facing
response (the upload reply, `/result`, `/my`, `/expenses/:id`) goes through
the allow-list in `src/views.js`: id, timestamp, name, category, note and the
claimed amount. No verdict, extracted amount, difference, tolerance, flag,
duplicate link or extractor detail; the stub-mode banner is admin-only too.
The verdict is still computed, stored, flagged and audited exactly as before,
and the admin sees all of it (dashboard, detail, audit log, CSV).

### What "member" means now

The member id in the session is an identity boundary: it comes from an account
only that person can log in to, and nothing in a request can change it. A
member sees only their own expenses and none of the verdict fields above; an
admin sees everything. An admin can still upload on a member's behalf
(choosing an existing member by id), which is audited with the admin as actor.

---

## 4. Deploy to Fly.io

App `pegasus-uav-expenses-th`, region `sin`, config in `fly.toml`.

### 4.1 Volume (required)

Fly Machines have an ephemeral root filesystem: a redeploy wipes it. The
`[mounts]` section attaches the Volume named `data` at `/data`, and `[env]`
points `DB_PATH=/data/pegasus.db` and `LOCAL_UPLOAD_DIR=/data/uploads` into it.
A Volume belongs to exactly one Machine and SQLite cannot be shared, so run a
single Machine (`fly scale count 1`). The service auto-stops when idle
(`min_machines_running = 0`) and wakes on the next request.

```bash
fly volumes create data --region sin --size 1   # once
```

### 4.2 Deploy

```bash
fly deploy
```

The `Dockerfile` (`node:24-bookworm-slim`, no compiler toolchain needed) builds
the image and `fly.toml` points the health check at `/healthz`, which reports
exactly which providers are live. Secrets are set with `fly secrets set
SESSION_SECRET=... ADMIN_PASSWORD=...`, never in `fly.toml`. A `Procfile`
(`web: node src/server.js`) is included for non-Docker builders. `railway.json`
is a leftover from the earlier Railway deploy and is not used on Fly.

### 4.3 Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DB_PATH` | **yes** | Inside the mounted Volume, e.g. `/data/pegasus.db` |
| `LOCAL_UPLOAD_DIR` | if using local storage | Also inside the Volume |
| `ADMIN_PASSWORD` | **first start only** | Temporary password of the bootstrap `admin` account, used only while no admin exists (must be changed at first login). Ignored afterwards |
| `SESSION_SECRET` | **yes** | `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`. Changing it logs everyone out |
| `TEAM_PASSCODE` | **retired** | No longer read; startup warns while it is set |
| `PUBLIC_ORIGIN` | no | e.g. `https://pegasus-uav-expenses-th.fly.dev`. Pins the CSRF origin check; unset = the request's Host |
| `LOGIN_RATE_LIMIT_ATTEMPTS` / `LOGIN_RATE_LIMIT_WINDOW_SECONDS` | no | Per-IP login attempts per window. Defaults `10` / `300` |
| `LOCKOUT_THRESHOLD` / `LOCKOUT_BASE_SECONDS` / `LOCKOUT_MAX_SECONDS` | no | Per-account lockout. Defaults `5` / `900` / `86400` |
| `SETUP_CODE_TTL_SECONDS` | no | Setup code lifetime. Default `259200` (72 h) |
| `PASSWORD_SCRYPT_N` | no | scrypt cost. Default `32768`; lower it only in tests |
| `COOKIE_SECURE` | no | Defaults to `1` unless `ALLOW_INSECURE_DEFAULTS=1` |
| `TRUSTED_PROXY_IPS` | **yes on Fly** | `*` trusts forwarding headers from the platform edge (rightmost `X-Forwarded-For` entry, `X-Forwarded-Proto`). Without it, every audit row logs the proxy's IP and all clients share one login rate-limit bucket. `*` is only safe when nothing but the proxy can reach the port |
| `CLIENT_IP_HEADER` | **yes on Fly** | `fly-client-ip` (set in `fly.toml`). Header the trusted proxy sets to the real client IP; preferred over `X-Forwarded-For`, read only from a trusted peer |
| `EXPENSE_CATEGORIES` | no | Comma-separated |
| `MATCH_EPSILON_THB` / `MATCH_EPSILON_PCT` | no | Defaults `1.0` / `0.005` |
| `GOOGLE_VISION_API_KEY` | for real OCR | Absent → LLM if `OPENROUTER_API_KEY` is set, else `StubOCRExtractor` |
| `OPENROUTER_API_KEY` | no | Enables the LLM stage (primary without Vision, fallback with it). Counts as real OCR for `REQUIRE_REAL_PROVIDERS` |
| `OPENROUTER_MODEL` | no | Vision-capable OpenRouter model id. Default `google/gemini-2.5-flash-lite` |
| `LLM_MIN_CONFIDENCE` / `LLM_MAX_AMOUNT_THB` | no | Defaults `0.5` / `1000000` |
| `GDRIVE_SA_JSON` | for Drive storage | Raw service-account JSON **or** its base64. Never a file in the repo |
| `GDRIVE_FOLDER_ID` | for Drive storage | Folder id inside a **Shared Drive** |
| `GDRIVE_FOLDER_VERIFIED` / `GDRIVE_FOLDER_REVIEW` / `GDRIVE_FOLDER_REJECTED` | no | Existing folder ids for the routed folders. Unset → `Verified` / `Needs-Review` / `Rejected` are found or created under `GDRIVE_FOLDER_ID` |
| `REQUIRE_REAL_PROVIDERS` | **yes in prod** | `1` → startup FAILS instead of running on stubs |
| `ENABLE_QR_STAGE` | no | `0` skips the QR stage |
| `MAX_UPLOAD_BYTES` | no | Default 8 MB |
| `LOG_LEVEL` | no | `debug` / `info` / `warning` / `error` / `silent` |

`.env.example` lists every variable. The npm scripts load `./.env` if present
for local use; on Fly the Dockerfile runs `node src/server.js` directly, so
production reads real Variables only.

### 4.4 Two manual steps still blocked on you

The code for both providers is written and tested against faked Google
endpoints. Neither has run against real Google services yet, because only you
can create the credentials.

**A. Google Cloud Vision API key (real OCR)**

1. In a Google Cloud project, enable **Cloud Vision API** (billing must be on).
2. Go to **APIs & Services → Credentials → Create credentials → API key**, then
   restrict the key to the Cloud Vision API.
3. Set `GOOGLE_VISION_API_KEY` as a Fly secret (`fly secrets set`). The key is sent in the
   `X-Goog-Api-Key` header, never in the URL.

**B. Shared Drive + service account (evidence storage)**

1. **IAM & Admin → Service Accounts → Create**, then **Keys → Add key → JSON**.
2. Create a folder inside a **Shared Drive**. Do not use My Drive: a service
   account has no storage quota, so uploads there fail. Share the folder with
   the service account's `client_email` as **Content manager**.
3. Put the whole key JSON into `GDRIVE_SA_JSON`. If the secrets UI mangles the
   multi-line value, use `base64 -i key.json | tr -d '\n'`. Put the folder id
   from its URL into `GDRIVE_FOLDER_ID`.
4. Delete the downloaded key file from your machine, or at least keep it out of
   every repo. `.gitignore` covers the usual names.

After both are set, add `REQUIRE_REAL_PROVIDERS=1`. If either credential is
missing or rejected, the app then refuses to start instead of quietly running
on stubs. Check `/healthz`: `using_stub_ocr` and `using_stub_storage` should
both be `false`.

### 4.5 Security checklist before sharing the link

- [ ] Strong `ADMIN_PASSWORD` for the first start, changed at first login
- [ ] Random `SESSION_SECRET` (32 bytes)
- [ ] `TEAM_PASSCODE` unset (retired)
- [ ] Every person has their own account; setup codes sent privately, not in
      a group chat
- [ ] App served over HTTPS (Fly forces HTTPS in `fly.toml`); leave `COOKIE_SECURE` unset or `1`
- [ ] `REQUIRE_REAL_PROVIDERS=1`
- [ ] Volume attached and `DB_PATH` pointing into it
- [ ] Slip images contain personal financial data, so keep the Drive folder
      private to the team

---

## 5. Layout

```
src/
  server.js          process entry: buildApp(process.env) + listen
  app.js             database → guard → admin bootstrap → providers → routes
  config.js          env-driven settings, epsilon tolerance, startup guard
  db/sql.js          schema + every statement as a module-level constant
  db/connection.js   node:sqlite handle, prepared-statement cache, transactions
  audit.js           audit writes, called at decision points
  session.js         signed timestamped session token {uid, role, sv} + cookie helpers
  auth.js            client IP, audited session gates (revocation, forced change, admin)
  accounts.js        accounts: credentials, setup codes, lockout, roles, bootstrap admin
  passwords.js       scrypt hashing, password policy, setup-code generation
  ratelimit.js       per-IP token bucket for POST /login
  csrf.js            same-origin check on every state-changing request
  permissions.js     permission (action) vs row-scope (member id from the session)
  members.js         display-name normalization, validation, lookup-or-create (migration)
  views.js           allow-list of the expense fields a member may see
  db/migrate.js      idempotent startup migration: members, expenses.member_id, review and account columns
  decision.js        THE DECISION POINT: extract → verdict → insert → audit → commit
  providers.js       explicit provider selection + REQUIRE_REAL_PROVIDERS
  csv.js             CSV export dialect (BOM, minimal quoting, CRLF)
  extraction/        base · amount-text · qr · qr-decode · vision · llm · stub · pipeline
  storage/           base · local · gdrive · google-auth
  slipverify/        base · null           (interface only; out of scope for v1)
  routes/            auth-routes · expenses · admin · admin-members · errors · http
shared/numbers.js    Python-compatible float/int parsing and round(); used by server AND browser
pages/               static HTML shells (login, logout, change-password, upload, result, my, expense,
                     admin, admin-members, audit, error)
public/css/app.css   hand-written CSS
public/js/           copy.js (Thai copy + formatting) · api.js · dom.js · error-view.js · pages/*.js
test/                node:test suites (ports of every Python test + new QR/Drive/number tests)
scripts/run_local.sh dev runner behind `npm run dev`
scripts/admin-reset.js recovery CLI behind `npm run admin:reset -- <username>`
```

---

## 6. HTTP surface

| Route | Gate | Returns |
|---|---|---|
| `GET /` | — | 303 to the session's home or `/login` |
| `GET /login` | — | page |
| `POST /login` | CSRF | form or JSON `{username, password}` → 303 (or `{location}` JSON with `Accept: application/json`); 401 `bad_credentials`, 423 `account_locked`, 403 `account_disabled`, 429 `rate_limited` (+ `Retry-After`), 403 `csrf_rejected` |
| `GET /admin/login`, `POST /admin/login` | — | 303 `/login` (retired) |
| `POST /logout` | CSRF | ends the account's sessions on all devices; 303 `/login` (or `{location}`) |
| `GET /logout` | — | page with a logout button (no state change) |
| `GET /account/password` | any session, incl. must-change | page |
| `GET /api/account` | any session, incl. must-change | `{id, username, name, role, must_change_password, using_setup_code}` |
| `POST /api/account/password` | any session, incl. must-change | JSON `{current_password, new_password}` (current = setup code when on one) → `{location}`; 400 `current_password_wrong` / `password_*`, 423, 409 `credential_changed` |
| `GET /upload`, `/result`, `/my`, `/expenses/:id` | member, page | page (303 `/login` without a session, 303 `/account/password` while a change is required) |
| `POST /upload` | member, api | member: `{status:"received", expense}`; admin (optional `member_id` of an existing member, default self): full decision JSON; 400 `unknown_member`, 422 `invalid_member_id` |
| `GET /api/upload-form`, `/api/my`, `/api/expenses/:id` | member, api | JSON (401 `{location}` without a session; 403 `password_change_required` + `location`) |
| `GET /admin`, `/admin/audit`, `/admin/members`, `/admin/export.csv`, `/admin/totals.xlsx` | admin, page | page / CSV / xlsx (a member session gets 303 `/upload`) |
| `GET /admin/expenses/:id/slip` | admin, page | the stored slip: images inline only when the file's leading bytes match its extension, anything else an `application/octet-stream` attachment; always `Cache-Control: private, no-store`, `nosniff`, `CSP: default-src 'none'; sandbox`; Drive rows 302 to the `drive.google.com` / `docs.google.com` link; 422 `invalid_id`, 404. Audited as `admin.view_slip` (success and failure) |
| `GET /admin/slips.zip` | admin, page | streamed zip of every local slip as `<name>_M<id>/<folder>/<file>`. Audited as `admin.export_slips`: a `started` row, then `success` or `aborted` (with `files`, `skipped`, `warnings`) |
| `GET /api/admin/expenses` | admin, api | `?verdict=verified\|needs-review\|rejected\|legacy` (the evidence folder) and `?member=` (name substring) → `{rows}` with only the columns the admin table shows (no file path, hash or extractor detail); 400 `invalid_verdict` |
| `GET /api/admin/members` | admin, api | `{members:[{id, username, name, role, disabled, locked, locked_until, failed_logins, needs_setup, setup_code_active, setup_code_expires_at, must_change_password, password_changed_at, created_at}], self_id}` |
| `POST /api/admin/members` | admin, api | `{username, name, role?}` → 201 `{member, setup_code, setup_code_expires_at}` (no-store); 409 `username_taken` / `name_taken` |
| `POST /api/admin/members/:id/setup-code` | admin, api | reset → `{member, setup_code, setup_code_expires_at}` |
| `POST /api/admin/members/:id/unlock` · `/disable` · `/enable` | admin, api | `{member}`; 409 `last_admin` / `cannot_disable_self` |
| `POST /api/admin/members/:id/role` · `/name` | admin, api | `{role}` / `{name}` → `{member}`; 409 `last_admin` / `name_taken` |
| `POST /api/admin/members/:id/username` | admin, api | `{username}` → `{member}`; ends that account's sessions; 400 `username_invalid`, 409 `username_taken`, 404 `member_not_found` |
| `GET /api/admin/dashboard`, `/api/admin/audit` | admin, api | JSON (a member session gets 403 `admin_required`) |
| `POST /api/admin/expenses/:id/review` | admin, api | JSON `{decision, approved_amount?, note?}` → updated row; 400 / 409 `not_pending` / 502 `evidence_move_failed` |
| `GET /healthz` | — | provider status JSON |

---

## 7. Deliberately deferred (v1 scope)

- **Bank slip verification**: `src/slipverify/` ships the interface plus
  `NullSlipVerifier`.
- **Editing or deleting an expense**: rows are append-only. The admin review
  only adds review fields and moves the file; the claim and the verdict stay.
- **Serving evidence images back through the app.**
- Merging two member rows, and two-factor login.
- **A shared rate-limit store**: the per-IP limit is in process memory (one
  machine); the per-account lockout is in the database.
- **Known amount-parser gaps** (label column above value column, untuned
  constants). They are documented in `src/extraction/amount-text.js` and wait
  for real Vision OCR samples.
