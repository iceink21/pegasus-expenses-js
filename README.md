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
# -> http://127.0.0.1:8811/   team passcode: pegasus-dev   admin: admin-dev
```

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

J=/tmp/cookies.txt
curl -s -c $J -b $J -X POST -d "passcode=pegasus-dev" http://127.0.0.1:8811/login
curl -s -c $J -b $J -X POST http://127.0.0.1:8811/upload \
  -F "member_name=ติ้ว" -F "category=อะไหล่โดรน" \
  -F "claimed_amount=1250.00" -F "note=test" \
  -F "slip=@/tmp/slip.jpg;type=image/jpeg"
```

The claim is 1250 and the slip reads 980, so the verdict is `MISMATCH`. The
expense row is flagged, and an `expense.decision.mismatch` audit row is written.
The response is JSON: the decision plus a `result_url` for the result page.
Markers:

| marker in the uploaded bytes | result |
|---|---|
| `PEGASUS_STUB_AMOUNT=980.00` | stub OCR "reads" 980.00 |
| `PEGASUS_STUB_UNREADABLE` | stub OCR finds nothing → `UNREADABLE` |
| neither | a deterministic synthetic amount derived from the image hash |

Upload the same file twice to see the duplicate-hash flag. The admin view is at
`/admin` (password `admin-dev`), the audit log at `/admin/audit`, and the JSON
behind them at `/api/admin/dashboard` and `/api/admin/audit`.

---

## 2. How a verdict is decided

```
upload ──► sha256 ──► duplicate check ──► store evidence
                                            │
                   QR stage (bonus) ────────┤
                   OCR stage (primary) ─────┤   Vision, else LLM, else stub
                   LLM fallback (optional) ─┘   only after Vision finds nothing
                                            ▼
                             src/decision.js :: recordSubmission
                             ├─ verdict computed server-side
                             ├─ BEGIN
                             ├─ expense row INSERT
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

All async work (evidence upload, OCR) finishes *before* `BEGIN`. The block
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
- every permission or scope denial (403)
- every request a session gate refuses: no session, or a team session on an
  admin route
- every failed or successful passcode attempt
- every logout
- every admin view and CSV export

---

## 3. Auth model

Auth is a shared team passcode plus a name picked from a list. There are **no**
per-user accounts:

1. A visitor enters the team passcode and gets a signed session cookie
   (HMAC-SHA256, HttpOnly, SameSite=Lax, Secure in production, 12 h max age).
2. On each upload they pick their name from the member dropdown.

A separate **admin password** opens the team lead view: all expenses, flags,
the audit log, and CSV export. Both secrets are compared as SHA-256 digests with
`crypto.timingSafeEqual`.

### Startup guard on default secrets

`TEAM_PASSCODE`, `ADMIN_PASSWORD` and `SESSION_SECRET` have defaults that are
**published in this repo**. The app **refuses to start** while any of them is
still at its default, and the error names the offending variables. Set
`ALLOW_INSECURE_DEFAULTS=1` to bypass it for local development (`run_local.sh`
does this for you). The same flag drives the `COOKIE_SECURE` default: cookies
are Secure unless you are explicitly in dev.

### What "member" actually means

There is **no enforced per-member access boundary**, and that is deliberate for
a four-person team. The member name is a client-asserted `?member=` label. The
session only proves that someone knew the team passcode. The row-label check
guards against mislabelling, not against access. It is still real and its
denials are audited, but anyone with the passcode can edit the label. Real
isolation needs per-user accounts, which are out of scope (§7).

---

## 4. Deploy to Railway

### 4.1 Attach a Volume (required)

Railway's plain filesystem is wiped on every redeploy. Without a Volume the
whole expense history disappears the next time anyone pushes.

1. Railway → service → **Settings → Volumes → Add Volume**, mount path `/data`
2. Set `DB_PATH=/data/pegasus.db`
3. If you use local evidence storage, set `LOCAL_UPLOAD_DIR=/data/uploads`
   (Google Drive is the better choice; see 4.4)

### 4.2 Deploy

```bash
railway up          # or connect the GitHub repo
```

`railway.json` builds with the `Dockerfile` (`node:24-bookworm-slim`, with no
compiler toolchain needed) and points the healthcheck at `/healthz`, which
reports exactly which providers are live. Railway sets `PORT`, and the server
listens on `0.0.0.0` by default. A `Procfile` (`web: node src/server.js`) is
included for non-Docker builders.

### 4.3 Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DB_PATH` | **yes** | Inside the mounted Volume, e.g. `/data/pegasus.db` |
| `LOCAL_UPLOAD_DIR` | if using local storage | Also inside the Volume |
| `TEAM_PASSCODE` | **yes** | Shared team passcode |
| `ADMIN_PASSWORD` | **yes** | Team-lead password, different from the above |
| `SESSION_SECRET` | **yes** | `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` |
| `COOKIE_SECURE` | no | Defaults to `1` unless `ALLOW_INSECURE_DEFAULTS=1` |
| `TRUSTED_PROXY_IPS` | **yes on Railway** | `*` trusts `X-Forwarded-For` from Railway's edge. Without it, every audit row logs the proxy's IP. `*` is only safe when nothing but the proxy can reach the port |
| `TEAM_MEMBERS` | no | Comma-separated Thai names |
| `EXPENSE_CATEGORIES` | no | Comma-separated |
| `MATCH_EPSILON_THB` / `MATCH_EPSILON_PCT` | no | Defaults `1.0` / `0.005` |
| `GOOGLE_VISION_API_KEY` | for real OCR | Absent → LLM if `OPENROUTER_API_KEY` is set, else `StubOCRExtractor` |
| `OPENROUTER_API_KEY` | no | Enables the LLM stage (primary without Vision, fallback with it). Counts as real OCR for `REQUIRE_REAL_PROVIDERS` |
| `OPENROUTER_MODEL` | no | Vision-capable OpenRouter model id. Default `google/gemini-2.5-flash-lite` |
| `LLM_MIN_CONFIDENCE` / `LLM_MAX_AMOUNT_THB` | no | Defaults `0.5` / `1000000` |
| `GDRIVE_SA_JSON` | for Drive storage | Raw service-account JSON **or** its base64. Never a file in the repo |
| `GDRIVE_FOLDER_ID` | for Drive storage | Folder id inside a **Shared Drive** |
| `REQUIRE_REAL_PROVIDERS` | **yes in prod** | `1` → startup FAILS instead of running on stubs |
| `ENABLE_QR_STAGE` | no | `0` skips the QR stage |
| `MAX_UPLOAD_BYTES` | no | Default 8 MB |
| `LOG_LEVEL` | no | `debug` / `info` / `warning` / `error` / `silent` |

`.env.example` lists every variable. The npm scripts load `./.env` if present
for local use; on Railway the Dockerfile runs `node src/server.js` directly, so
production reads real Variables only.

### 4.4 Two manual steps still blocked on you

The code for both providers is written and tested against faked Google
endpoints. Neither has run against real Google services yet, because only you
can create the credentials.

**A. Google Cloud Vision API key (real OCR)**

1. In a Google Cloud project, enable **Cloud Vision API** (billing must be on).
2. Go to **APIs & Services → Credentials → Create credentials → API key**, then
   restrict the key to the Cloud Vision API.
3. Set `GOOGLE_VISION_API_KEY` in Railway. The key is sent in the
   `X-Goog-Api-Key` header, never in the URL.

**B. Shared Drive + service account (evidence storage)**

1. **IAM & Admin → Service Accounts → Create**, then **Keys → Add key → JSON**.
2. Create a folder inside a **Shared Drive**. Do not use My Drive: a service
   account has no storage quota, so uploads there fail. Share the folder with
   the service account's `client_email` as **Content manager**.
3. Put the whole key JSON into `GDRIVE_SA_JSON`. If Railway mangles the
   multi-line value, use `base64 -i key.json | tr -d '\n'`. Put the folder id
   from its URL into `GDRIVE_FOLDER_ID`.
4. Delete the downloaded key file from your machine, or at least keep it out of
   every repo. `.gitignore` covers the usual names.

After both are set, add `REQUIRE_REAL_PROVIDERS=1`. If either credential is
missing or rejected, the app then refuses to start instead of quietly running
on stubs. Check `/healthz`: `using_stub_ocr` and `using_stub_storage` should
both be `false`.

### 4.5 Security checklist before sharing the link

- [ ] Strong `TEAM_PASSCODE` and a *different* strong `ADMIN_PASSWORD`
- [ ] Random `SESSION_SECRET` (32 bytes)
- [ ] App served over HTTPS (Railway default); leave `COOKIE_SECURE` unset or `1`
- [ ] `REQUIRE_REAL_PROVIDERS=1`
- [ ] Volume attached and `DB_PATH` pointing into it
- [ ] Slip images contain personal financial data, so keep the Drive folder
      private to the team

---

## 5. Layout

```
src/
  server.js          process entry: buildApp(process.env) + listen
  app.js             guard → database → providers → routes
  config.js          env-driven settings, epsilon tolerance, startup guard
  db/sql.js          schema + every statement as a module-level constant
  db/connection.js   node:sqlite handle, prepared-statement cache, transactions
  audit.js           audit writes, called at decision points
  session.js         signed timestamped session token + cookie helpers
  auth.js            constant-time secret check, client IP, audited session gates
  permissions.js     permission (action) vs row-scope (client-asserted member label)
  decision.js        THE DECISION POINT: extract → verdict → insert → audit → commit
  providers.js       explicit provider selection + REQUIRE_REAL_PROVIDERS
  csv.js             CSV export dialect (BOM, minimal quoting, CRLF)
  extraction/        base · amount-text · qr · qr-decode · vision · llm · stub · pipeline
  storage/           base · local · gdrive · google-auth
  slipverify/        base · null           (interface only; out of scope for v1)
  routes/            auth-routes · expenses · admin · errors · http
shared/numbers.js    Python-compatible float/int parsing and round(); used by server AND browser
pages/               static HTML shells (login, upload, result, my, expense, admin, audit, error)
public/css/app.css   hand-written CSS
public/js/           copy.js (Thai copy + formatting) · api.js · dom.js · error-view.js · pages/*.js
test/                node:test suites (ports of every Python test + new QR/Drive/number tests)
scripts/run_local.sh dev runner behind `npm run dev`
```

---

## 6. HTTP surface

| Route | Gate | Returns |
|---|---|---|
| `GET /` | — | 303 to `/upload` or `/login` |
| `GET /login`, `GET /admin/login` | — | page |
| `POST /login`, `POST /admin/login` | — | 303 (or `{location}` JSON when `Accept: application/json`); 401 `{detail}` on a wrong secret |
| `GET /logout` | — | 303 `/login` |
| `GET /upload`, `/result`, `/my`, `/expenses/:id` | team, page | page (303 `/login` without a session) |
| `POST /upload` | team, api | decision JSON |
| `GET /api/upload-form`, `/api/my`, `/api/expenses/:id` | team, api | JSON (401 `{location}` without a session) |
| `GET /admin`, `/admin/audit`, `/admin/export.csv` | admin, page | page / CSV |
| `GET /api/admin/dashboard`, `/api/admin/audit` | admin, api | JSON |
| `GET /healthz` | — | provider status JSON |

---

## 7. Deliberately deferred (v1 scope)

- **Bank slip verification**: `src/slipverify/` ships the interface plus
  `NullSlipVerifier`.
- **Editing or deleting an expense**: rows are append-only.
- **Rate limiting on the passcode forms**: failures are audited, but there is
  no lockout yet. Add one before the link goes anywhere public.
- **Serving evidence images back through the app.**
- **Per-user accounts**, and therefore any real per-member access boundary.
- **Known amount-parser gaps** (label column above value column, untuned
  constants). They are documented in `src/extraction/amount-text.js` and wait
  for real Vision OCR samples.
