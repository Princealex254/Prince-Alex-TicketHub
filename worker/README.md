# Prince Alex TicketHub — Worker Backend

Production backend for **Prince Alex TicketHub** (Powered by Prince Alex Digital).
Deployed to the **existing** Worker: `https://princealextickethub.princealexdigital.workers.dev/`

| File        | Purpose                                                        |
|-------------|----------------------------------------------------------------|
| `index.js`  | The complete Cloudflare Worker (single deployable file)         |
| `schema.sql`| Complete D1 schema: 13 tables, 45 indexes                      |

Firebase Authentication is **not** replaced — the Worker only *verifies* ID tokens
(RS256 against Google's published signing keys, issuer/audience bound to the project)
and maps the Firebase UID to a D1 user. Access control is always re-checked in D1.

---

## 1. Deployment

### 1.1 Where to put `index.js`
The Worker already exists (`princealextickethub`). Update it with wrangler from this folder:

```powershell
cd worker
npm install -g wrangler          # once
wrangler login
wrangler deploy
```

Or paste the contents of `index.js` into the Worker's editor at
https://dash.cloudflare.com → Workers & Pages → `princealextickethub` → Edit code.

### 1.2 Run the D1 schema
```powershell
wrangler d1 execute <YOUR_DATABASE_NAME> --file schema.sql --remote
```
Every statement is `IF NOT EXISTS`, so it is safe to re-run. The database must be the
one bound as `DB`.

**An existing database: run the migrations, in order.**

```powershell
wrangler d1 execute <DB> --remote --file worker/migrations/0001_rate_limits.sql  # rate limit table
wrangler d1 execute <DB> --remote --file worker/migrations/0002_payhero.sql     # PayHero + per-provider credentials
```

If `0002_payhero.sql` stops with `duplicate column name: ...`, D1 stopped on that
statement and the statements after it never ran (the columns before it are applied and
committed). Finish the job with the repair files, which add only what is missing so an
already-present column cannot hold up the rest:

```powershell
wrangler d1 execute <DB> --remote --file worker/migrations/0003_payhero_repair.sql         # missing columns + provider table + backfill
wrangler d1 execute <DB> --remote --file worker/migrations/0004_payhero_check_rebuild.sql  # widen the provider CHECK constraints
wrangler d1 execute <DB> --remote --file worker/migrations/0005_email_free_tickets.sql     # free-ticket verification
wrangler d1 execute <DB> --remote --file worker/migrations/0006_free_ticket_limits.sql   # per-event free-ticket thresholds
wrangler d1 execute <DB> --remote --file worker/migrations/0007_payment_money_trail.sql  # collected_via snapshots
wrangler d1 execute <DB> --remote --file worker/migrations/0008_organizer_agreements.sql # organizer agreement + platform fees (REQUIRED before publishing)
```

`GET /api/health` answers `payment_schema.ready` together with the exact file still to run
(`missing`, `migrations`, `hint`), and any checkout that touches an un-migrated table
answers `MIGRATION_REQUIRED` — never a bare 500. The symptom this fixes is
`D1_ERROR: no such column: provider_metadata at offset 114` when the buyer confirms
payment. `PAYMENT_ENCRYPTION_KEY` must be set before an organizer can save credentials.

### 1.3 Bindings (Dashboard → Worker → Settings → Bindings)
| Binding  | Type        | Required for                      | Value                   |
|----------|-------------|-----------------------------------|-------------------------|
| `DB`     | D1 database | **everything**                    | your TicketHub database |
| `BUCKET` | R2 bucket   | posters, logos, `GET /media/:key` | your poster bucket      |

Binding **names are fixed**: the Worker reads `env.DB` and `env.BUCKET` only.
There is no `MEDIA`, `KV` or `R2_*` binding to create.

### 1.4 Variables and secrets — the complete list

Every name below is taken from `env.*` in `index.js`. **Create only these names** —
they are exact and case-sensitive, and the HTTP header names
(`Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`,
`Access-Control-Allow-Headers`, `Access-Control-Max-Age`) are produced by the code,
so they are **not** variables you create.

| Name | Kind | Required? | Used for | If missing |
|------|------|-----------|----------|------------|
| `DB` | Binding (D1) | **Yes** | every route | nothing works |
| `BUCKET` | Binding (R2) | Yes, for posters/logos | `GET /media/…`, poster + logo upload/delete | uploads and images fail |
| `FIREBASE_PROJECT_ID` | Var or secret | **Yes** for every signed-in page | verifies Firebase ID tokens against Google's public JWKs, cached for an hour and refreshed once on an unknown `kid` (`index.js:174`–`178`) | `500 FB_NOT_CONFIGURED`; all authenticated calls fail |
| `ALLOWED_ORIGINS` | Var | **Yes** | CORS allow-list, comma-separated (`index.js:71`) | no `Access-Control-Allow-Origin` → browser CORS errors (only the built-in dev origins still work) |
| `FRONTEND_URL` | Var | Recommended | added to the CORS allow-list (`index.js:74`) **and** builds the payment return URL `/payment-success/?reference=…` (`callbackUrlFor`) | payment callback and all email links fall back to `https://tickethub.princealex.digital` |
| `PAYMENT_ENCRYPTION_KEY` | Secret | Yes, before an organizer saves merchant credentials | AES-GCM key that encrypts stored Paystack/Pesapal secrets (`index.js:152`) | `500 KEY_MISSING` on payment-settings save/test |
| `PAYSTACK_SECRET_KEY` | Secret | Optional* | platform-level Paystack fallback for organizers without their own account (`index.js:976`) | checkout reports `provider_ready:false` / `PROVIDER_NOT_CONNECTED` |
| `PESAPAL_CONSUMER_KEY` | Secret | Optional* | platform-level Pesapal fallback (`index.js:984`) | same as above |
| `PESAPAL_CONSUMER_SECRET` | Secret | Optional* | platform-level Pesapal fallback (`index.js:985`) | same as above |
| `PESAPAL_ENV` | Var | Optional | `live` switches Pesapal to production; anything else (default `sandbox`) uses the Pesapal sandbox (`index.js:1023`) | Pesapal stays in sandbox |
| `TURNSTILE_SECRET` | Secret | **Yes**, to enforce bot protection | Cloudflare Turnstile secret key. Verified server-side on registration, login/password-reset challenges, event creation, contact and checkout (`turnstileVerify`, `requireTurnstile`) | protected endpoints return `400 TURNSTILE_TOKEN_INVALID` / `403` / `503` because the pages cannot send a token (the check is skipped entirely while the secret is unset, and one `turnstile_not_configured` warning is logged per isolate) |
| `TURNSTILE_HOSTNAMES` | Var | Optional | comma-separated hostnames allowed to solve a challenge. Default: `tickethub.princealex.digital`, the Worker's own origin and the local dev hosts | a token solved on any other host is refused with `403 TURNSTILE_HOSTNAME` |
| `BREVO_API_KEY` | Secret | Yes, to send any email | Brevo transactional API key (`xkeysib-…`). Every mail is written to `email_outbox` first and relayed through `POST https://api.brevo.com/v3/smtp/email` (`emails.js:1349`, `emails.js:1418`) | nothing is sent; rows pile up as `queued` and the owner page shows **No API key** |
| `EMAIL_FROM` | Var | Optional | fallback sender address when `app_settings.email_from_email` is unset (`emails.js:1391`) | the built-in brand address is used |
| `EMAIL_FROM_NAME` | Var | Optional | fallback sender display name (`emails.js:1395`) | platform name is used |
| `EMAIL_REPLY_TO` | Var | Optional | fallback reply-to (`emails.js:1396`) | the support email is used |
| `EMAIL_DISABLED` | Var | Optional | `true` pauses all outbound mail (`emails.js:1403`) | mail is sent normally |
| `SUPPORT_EMAIL` | Var | Optional | last-resort sender/contact address (`emails.js:1393`) | the built-in brand address is used |

\* Payments still work with these unset — the event organizer connects their own
merchant account in *Organizer → Settings → Payment Settings*. Set
`PAYSTACK_SECRET_KEY` if you prefer a single platform launch account.

**Minimum to launch** (after the two bindings):

```
FIREBASE_PROJECT_ID      = prince-alex-tickethub
ALLOWED_ORIGINS          = https://tickethub.princealex.digital
FRONTEND_URL             = https://tickethub.princealex.digital
PAYMENT_ENCRYPTION_KEY   = <random 32-byte key>
PAYSTACK_SECRET_KEY      = sk_live_…            # or let each organizer connect their own
BREVO_API_KEY            = xkeysib-…            # transactional email (tickets, receipts, alerts)
EMAIL_FROM               = tickets@your-domain  # optional: overrides the built-in sender
TURNSTILE_SECRET         = <Turnstile secret>   # bot protection (secret, never a var)
TURNSTILE_HOSTNAMES      = tickethub.princealex.digital   # optional, plain text
```

**Create them in the dashboard** (Cloudflare → Workers & Pages → `princealextickethub`
→ Settings → **Variables and Secrets**):

| Name | Choose type |
|------|-------------|
| `FIREBASE_PROJECT_ID`, `ALLOWED_ORIGINS`, `FRONTEND_URL`, `PESAPAL_ENV`, `EMAIL_FROM`, `EMAIL_FROM_NAME`, `EMAIL_REPLY_TO`, `EMAIL_DISABLED`, `SUPPORT_EMAIL`, `TURNSTILE_HOSTNAMES` | Text (plain) — or Secret, both land in `env` |
| `PAYSTACK_SECRET_KEY`, `PAYMENT_ENCRYPTION_KEY`, `PESAPAL_CONSUMER_KEY`, `PESAPAL_CONSUMER_SECRET`, `TURNSTILE_SECRET`, `BREVO_API_KEY` | Secret (encrypted) |

Press **Save and Deploy** afterwards — vars added without a redeploy are not live.

**Create them with wrangler** (from this `worker/` folder):
```powershell
wrangler secret put FIREBASE_PROJECT_ID        # prince-alex-tickethub
wrangler secret put PAYMENT_ENCRYPTION_KEY     # random 32-byte key, e.g. openssl rand -base64 32
wrangler secret put PAYSTACK_SECRET_KEY        # sk_live_… / sk_test_… (Paystack)
wrangler secret put BREVO_API_KEY              # xkeysib-… (Brevo transactional email)
wrangler secret put PESAPAL_CONSUMER_KEY       # optional platform fallback
wrangler secret put PESAPAL_CONSUMER_SECRET    # optional platform fallback
wrangler secret put TURNSTILE_SECRET           # Cloudflare Turnstile secret (bot protection)
wrangler secret put ALLOWED_ORIGINS            # non-sensitive, but this works too
wrangler secret put FRONTEND_URL
wrangler secret put PESAPAL_ENV                # sandbox | live
```
`wrangler secret put TURNSTILE_SECRET` prompts for the value; nothing is written to
disk and nothing appears in `wrangler.toml`. In the dashboard use
**Settings → Variables and Secrets → Add → Secret**, name it `TURNSTILE_SECRET`,
paste the Turnstile secret, then **Save and Deploy**. The older name
`TURNSTILE_SECRET_KEY` is still read, so an existing deployment keeps working.
There is no `wrangler.toml` in this repo yet; plain-text vars can also live in one
as `[vars]` and are then deployed by `wrangler deploy`.

**Email dispatch.** Every route that queues mail (`email_outbox`) also flushes the
queue inline through `ctx.waitUntil`, and *Owner → Settings → Transactional email*
has a **Flush queue now** button. To heal a short Brevo outage automatically, add an
optional Cron Trigger:

```toml
[triggers]
crons = ["*/5 * * * *"]
```

The Worker's `scheduled` handler sends up to 25 queued messages per run and keeps
retrying (5 attempts, then the row is parked as `failed` and shown in the owner page,
where **Retry** re-queues it).

### 1.5 Deploying this Worker — two supported layouts

The API is a **module** (`index.js` + `emails.js`, joined by a relative import), so how
you deploy decides whether that import can be resolved.

**A. Wrangler (recommended, two files).** `wrangler deploy` follows the relative
import itself and uploads both modules. `worker/wrangler.toml` is already set up with
`main = "index.js"`; uncomment the `[vars]`, `[[d1_databases]]` and `[[r2_buckets]]`
blocks, fill in your ids, then:

```powershell
cd worker
wrangler deploy
```

**B. Cloudflare dashboard code editor (single file).** The dashboard editor deploys
**one** module and calls it `worker.js`, so pasting `index.js` alone fails at runtime
with:

```
Uncaught Error: No such module "emails.js". imported from "worker.js"
```

Fix: build the single-file bundle, which inlines `emails.js` (same behaviour, same
secrets and bindings — `index.js`'s `import` is replaced by an inlined module and a
destructuring assignment), then paste the generated file:

```powershell
powershell -ExecutionPolicy Bypass -File worker\build-single-file.ps1
# or double-click worker\build-single-file.cmd
```

That writes `worker/worker.js` (≈290 KB, regenerated, never hand-edited). Paste the
whole file into the dashboard editor and **Deploy**. Bindings (`DB`, `BUCKET`) and
secrets (`BREVO_API_KEY`, `FIREBASE_PROJECT_ID`, …) are configured in the dashboard
exactly as in §1.3–1.4 — the bundle reads the same `env` names.

Re-run the build after **every** change to `index.js` or `emails.js`, or the deployed
copy silently drifts behind. The two builds were verified to be output-identical for
all 15 email templates.

**Do not create these** — older docs list them, but nothing in this Worker reads them:
- `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` — ID tokens are verified with
  Google's public keys (JWK), so no Admin SDK credentials are needed.
  (`FIREBASE_PROJECT_ID` *is* required.)
- `PAYSTACK_WEBHOOK_SECRET` — the Paystack webhook signature is verified with the
  organizer/platform **secret key** (`webhookSignatureValid`).
- `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` — R2 is
  reached through the `BUCKET` binding.
- `MEDIA` (the binding is named `BUCKET`), `APP_BASE_URL`, KV for rate limiting
  (limiting is in-memory per isolate).
- `STAFF_EMAIL_FROM` — replaced by `EMAIL_FROM` (or the `email_from_email` platform
  setting in *Owner → Settings*), which `emails.js:1391` actually reads.

For development you may set `ALLOWED_ORIGINS = *` to allow every origin. The
Worker treats `*` as "allow any": it echoes the request's own `Origin` header
back (rather than emitting a literal `*`), which keeps `Vary: Origin` caching
correct and stays compatible with credentialed requests. **Switch to an
explicit comma-separated origin list before going to production.**

So `ALLOWED_ORIGINS = *` is the Worker equivalent of a hand-written
`"Access-Control-Allow-Origin": request.headers.get("Origin")` header — with
`Vary: Origin` kept and without ever emitting a literal `*`.

Every response the Worker returns is passed through `withCors()` in the entry
point, so the CORS headers are attached even if a new route forgets to pass
`corsFor(env, request)`. Preflight (`OPTIONS`) answers `204` for allow-listed
origins and unlisted origins simply get no `Access-Control-Allow-Origin`.

Notes that save time:

- **Opening the pages as local files.** A `file://` page sends `Origin: null`,
  which matches no allow-list entry. Serve the folder instead so the origin is
  `http://localhost:5500` (VS Code *Live Server*) or `http://localhost:8000`
  (`python -m http.server 8000`) — both are built in and always allowed — or set
  `ALLOWED_ORIGINS = *` while testing.
- **Trailing slashes do not matter.** Entries are normalised, so
  `https://tickethub.co/` and `https://tickethub.co` behave the same. The listed
  origins are `ALLOWED_ORIGINS` + `FRONTEND_URL` + the built-in dev origins
  (`localhost:8000`, `127.0.0.1:8000`, `localhost:5500`, `127.0.0.1:5500`) + the
  Worker's own origin.
- **`Invalid SPKI input.` in the logs is a stale build.** It comes from importing
  Google's X.509 *certificate* DER as `spki` (`importKey("spki", certDer, …)`),
  which BoringSSL rejects: a certificate is not a SubjectPublicKeyInfo. The
  current `index.js` fetches the JWK set
  (`https://www.googleapis.com/robot/v1/metadata/jwk/securetoken@system.gserviceaccount.com`)
  and imports each entry with `importKey("jwk", …)`. If that message ever
  reappears, the Worker is running an older revision - redeploy `index.js` (and
  check that no gradual deployment is still serving the previous version). A
  key-format failure now logs `TICKETHUB_ERROR CERTS` / `CERT_IMPORT` instead of
  a bare `SERVER_ERROR`.

- **Turnstile must be wired on both sides.** The six protected pages
  (`register/`, `login/`, `forgot-password/`, `contact/`,
  `checkout/`, `create-event/`) carry the real site key
  `0x4AAAAAAFFfPC7TnnFT83yZ` and send `turnstile_token`; the Worker reads the
  secret from `TURNSTILE_SECRET`. If only one side is done, protected endpoints
  answer `400 TURNSTILE_TOKEN_INVALID` (page has no token) or refuse everything
  the site key could not sign. While the secret is unset the check is skipped and
  logged once per isolate as `turnstile_not_configured`.

### Rate limiting (server-side)

Every limit lives in one table, `RATE_POLICIES` in `index.js`, and one function,
`guardRate(env, request, action, {...})`. No route contains a number of its own.
Enforcement happens in three tiers, cheapest first:

1. **memory** – per-isolate fixed window. Free, so a flood is refused before any
   D1 round trip. Also the fail-safe when D1 is unavailable. The window length is
   part of the key, so an action with two tiers on one identity (e.g. `checkin`,
   `order_lookup`) keeps one counter per window instead of one shared counter.
2. **binding** – Cloudflare's native Rate Limiting binding, used when one is bound
   as `RATE_LIMITER` (see `wrangler.toml`). Native, writes no rows.
3. **D1** – the authoritative cross-isolate counter, in the `rate_limits` table.

```js
await guardRate(env, request, "checkout", { ref: reference });   // what routes call
await rateLimit({ env, key, limit, windowSeconds, action, store }); // the primitive
```

| Action | Tiers (default) | Routes |
|---|---|---|
| `login` | 5 / 15 min per IP **+** 10 / 15 min per account | `POST /api/auth/turnstile` (action `login`) |
| `password_reset` | 3 / hour per email **+** 5 / hour per IP | `POST /api/auth/turnstile` (action `password-reset`) |
| `otp` | 3 / hour per email **+** 5 / hour per IP | `POST /api/auth/turnstile` (action `email-verification`) |
| `register` | 5 / hour per IP | `POST /api/auth/register` |
| `event_create` | 10 / hour per user **+** 60 / hour per IP | `POST /api/organizer/events` |
| `checkout` | 10 / 10 min per IP **+** 5 / 10 min per order reference | `POST /api/orders`, `POST /api/payments/:provider/initiate` |
| `contact` | 5 / hour per IP **+** 3 / hour per address | `POST /api/contact` |
| `ticket_email` | 5 / 10 min per IP, per order **+** 5 / hour per address | `POST /api/tickets/send-email` |
| `order_lookup` | 20 / min **+** 120 / hour per IP **+** 10 / 10 min per address | `POST /api/orders/lookup` |
| `checkin` | 300 / min **+** 6000 / hour per user, 600 / min per IP | `POST /api/check-in` |
| `owner_email` | 30 / 10 min per owner **+** 60 / 10 min per IP | owner email send / test |
| `payment_status`, `order_tickets`, `ticket_lookup`, `ticket_qr`, `poster`, `logo`, `ticket_type`, `payment_settings`, `payment_test` | memory tier, per IP | the matching routes |

**Identity.** `user:<firebase_uid>` once the caller is proven (the UID is read
from the token with `callerUid()` *without* touching D1, so a flood cannot
provision user rows), `ip:<CF-Connecting-IP>` otherwise, `email:<sha256(normalised
address)>` for account-shaped actions and `ref:<ORDER-REFERENCE>` for checkout.
Emails are trimmed and lower-cased first, so `"  Jane@Example.COM "` and
`jane@example.com` share one bucket. `CF-Connecting-IP` is the only trusted IP
header (Cloudflare overwrites it); `X-Forwarded-For` is only a local-testing
fallback. IPv4 and IPv6 are treated as distinct keys.

Layering is the point: rotating IPs still hits the email/user tier, rotating
emails still hits the IP tier, and no identity is trusted on its own.

**Atomicity.** The D1 tier never reads-then-writes. One
`INSERT … ON CONFLICT(rate_key) DO UPDATE SET request_count = MIN(request_count + 1, limit+1)`
followed by a `SELECT`, both inside `env.DB.batch()` (one transaction). Each
upsert is applied to the previously committed value, so two simultaneous requests
cannot both act on the same count; the `limit+1` cap means an attacker cannot
inflate the row. The harness proves 8 simultaneous requests against a limit of 3
yield exactly 3 acceptances.

**Storage.** `rate_key` is `sha256(identity|window_start)`, so **no IP, UID or email
address is ever written to D1**, and one identity is one row per window (not per
request). Expired windows are deleted by an in-request sweep (2% of calls) and on
every cron tick.

**Refusals** answer `429` with `Retry-After`, `code: "RATE_LIMITED"`, a
`retry_after` field and a message that says when to come back but never which
limit was hit. Every refusal is logged as a `TICKETHUB_SECURITY` event
(`SUSPICIOUS_AUTH_ACTIVITY`, `EXCESSIVE_PASSWORD_RESET_REQUESTS`,
`EXCESSIVE_CHECKOUT_ATTEMPTS`, …) with the action, tier, limit and retry hint –
never an address, token or secret.

**Order of operations** on protected routes: parse → **rate limit** → Turnstile →
Firebase auth → authorization → business logic. A challenge success is never a
rate-limit exemption, a rate-limit hit never skips Turnstile, and a request that
is over the limit is refused *before* the Siteverify call is made.

**Not limited on purpose:** public event browsing, event pages, categories,
media/posters, and every payment callback/webhook (`/api/webhooks/*`) which must
always be receivable. Use Cloudflare WAF / rate-limiting rules for broad traffic
shaping, and the optional `RATE_LIMITER` binding for edge-level limits.

**Migration** (required before deploying, otherwise the memory tier is the only
limit – `/api/health` reports `rate_limit_store: "degraded"`):

```
wrangler d1 execute princealextickethub --file=worker/migrations/0001_rate_limits.sql
```

### Turnstile (bot protection)

What the Worker enforces on every protected route, before any other work:

| Check | Result when it fails |
|-------|----------------------|
| token present, 10–2048 chars, URL-safe | `400 TURNSTILE_TOKEN_INVALID` |
| `siteverify` answered `success:true` | `403 TURNSTILE_TOKEN_INVALID` (or `…_TOKEN_REUSED` for `timeout-or-duplicate`, i.e. expired or already redeemed) |
| `hostname` in `TURNSTILE_HOSTNAMES` (default: the production host) | `403 TURNSTILE_HOSTNAME` |
| `action` equals the route's action | `403 TURNSTILE_ACTION` |
| Siteverify answered within 8s | `503 TURNSTILE_UNAVAILABLE` (fails safely; never a silent pass) |
| token not already redeemed by this isolate | `403 TURNSTILE_TOKEN_REUSED` (SHA-256 hashes only, kept 5 minutes) |

Actions in use: `register`, `login`, `password-reset`, `contact`, `checkout`,
`event-create`. Firebase sign-in and password reset are browser-side calls, so
those pages verify the challenge at `POST /api/auth/turnstile` first (rate
limited per action and IP) and only then call Firebase. Payment webhooks/IPN
callbacks never require a token: they authenticate with their own Paystack HMAC /
Pesapal transaction-status check.

A checkout needs one challenge, not two: `POST /api/orders` returns a
`checkout_proof` receipt (HMAC over the order reference, the client IP and a
5-minute expiry) that `POST /api/payments/:provider/initiate` accepts instead of
a second, already-spent token. A caller with neither receipt nor fresh token is
rejected.

**Testing with Cloudflare's test keys** (never in production):

```
# Worker (secret, per environment)
wrangler secret put TURNSTILE_SECRET   # 1x0000000000000000000000000000000AA = always passes
# Pages: temporarily use site key 1x00000000000000000000AA (always passes)
```

| Test secret | Dummy token `XXXX.DUMMY.TOKEN.XXXX` |
|-------------|----------------------------------------|
| `1x0000000000000000000000000000000AA` | verification succeeds |
| `2x0000000000000000000000000000000AA` | `403 TURNSTILE_TOKEN_INVALID` |
| `3x0000000000000000000000000000000AA` | `403 TURNSTILE_TOKEN_REUSED` |

These dummy secrets report `hostname: "example.com"` and an empty `action`, so
the Worker relaxes the hostname and action checks **for dummy secrets only** —
the `success` flag is still required, and a dummy secret can only be set
deliberately. Siteverify sends no CORS headers, so this can only be verified
through the Worker, never from a browser page. `turnstile-check.html` in the
repository root exercises all of the above offline (67 checks) and finishes with
the "browser cannot call Siteverify" case.

- **Redeploy after editing variables** (`wrangler deploy`, or **Save and Deploy** in
  the dashboard) — until then the Worker keeps the previous `env`.
- If `Access-Control-Allow-Origin` is missing from the `OPTIONS` response in §1.5,
  the origin is not in `ALLOWED_ORIGINS`/`FRONTEND_URL`, or the Worker has not been
  redeployed with the new value.

### 1.5 Smoke test
```powershell
curl https://princealextickethub.princealexdigital.workers.dev/api/health
# {"success":true,"service":"Prince Alex TicketHub API","status":"ok"}
```
Then check CORS:
```powershell
curl -X OPTIONS -H "Origin: https://<your-frontend-domain>" `
  -H "Access-Control-Request-Method: GET" `
  https://princealextickethub.princealexdigital.workers.dev/api/health -i
# expect 204 + Access-Control-Allow-Origin echoed for allow-listed origins
```

### 1.6 R2 poster delivery
Posters are served by the Worker itself — no public bucket needed:
`GET /media/events/<eventId>/<file>.jpg` streams from `BUCKET` with long-lived cache
headers and only accepts keys under the `events/` prefix (no traversal). Store
`poster_url` pointing at this route and `poster_key` as the R2 object key.

---

## 2. Frontend integration

The existing TicketHub pages already call the API through their shared `api()` helper.
Once `API_BASE` is pointed at the live Worker, no further wiring is needed:

```js
// every page already defines this
const API_BASE = "https://princealextickethub.princealexdigital.workers.dev";
```

### 2.1 Authenticated requests

The `api()` helper in the app kit attaches the Firebase ID token and unwraps
`{ success, data }`. It is equivalent to:

```js
async function api(path, options = {}) {
  const user = await Auth.user();                    // from firebase.js
  const headers = { "Content-Type": "application/json" };
  if (user) headers.Authorization = `Bearer ${await user.getIdToken()}`;
  const res = await fetch(API_BASE + path, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (!body.success) throw Object.assign(new Error(body.error || "Request failed"), { code: body.code, status: res.status });
  return body.data;
}
```


---

## 3. Payment setup (organizer flow)

Each organizer connects their **own** merchant account. Credentials are encrypted
(AES-GCM, key = the `PAYMENT_ENCRYPTION_KEY` Worker secret) before storage and are
**never returned to the browser** — `GET /api/organizer/payment-settings` reports
only `provider`, `status` and a masked hint (e.g. `sk_live_…4f2a`).

Flow (`organizer-settings/index.html` → Payment Settings):

1. **Login → Organizer Dashboard → Settings → Payment Settings**
2. Choose the provider: **Paystack** or **Pesapal**
3. Enter credentials
   - Paystack: `public_key` (`pk_…`) + `secret_key` (`sk_…`) from the Paystack dashboard
   - Pesapal: `consumer_key` + `consumer_secret` + `ipn_id` from the Pesapal dashboard
4. **Test connection** → `POST /api/organizer/payment-settings/test`
   - Paystack: read-only verification call using the stored secret key (no charge created)
   - Pesapal: exchanges the credentials for an OAuth access token; validates `ipn_id` if set
5. **Save** → `PUT /api/organizer/payment-settings`

Rules:

- Checkout always uses the event organizer's connected provider. If none is connected,
  the order/payment API returns a clear `PROVIDER_NOT_CONNECTED` error — the Worker
  never falls back to a different provider silently.
- The platform secrets `PESAPAL_CONSUMER_KEY` / `PESAPAL_CONSUMER_SECRET` are a fallback
  only for organizers who have not stored their own credentials (platform-managed mode).
- Changing the provider never affects already-paid orders or issued tickets.

---

## 4. Testing checklist

Run against the live Worker after deployment. `/api/health` must pass first; the
payment-provider tests (23–31) need Paystack test keys (`sk_test_…`) and/or the
Pesapal sandbox.

| # | Test | How | Expected |
|---|------|-----|----------|
| 1 | Health | `curl /api/health` | 200, `{"success":true,"service":"Prince Alex TicketHub API","status":"ok"}` |
| 2 | CORS preflight | `curl -X OPTIONS -H "Origin: <frontend>" -H "Access-Control-Request-Method: GET" -i /api/health` | 204 + ACAO echoed for allow-listed origins; no ACAO for others |
| 3 | Unauthorized request | `GET /api/organizer/events` without `Authorization` | 401 |
| 4 | Invalid token | `Authorization: Bearer junk` | 401 |
| 5 | Firebase auth + bootstrap | register on the site, then `GET /api/me` | D1 user created with role `organizer`; never auto-`owner` |
| 6 | Organizer authorization | organizer A's token calls `PUT /api/organizer/events/<id-of-B>` | 403/404, no data leak |
| 7 | Event creation | `POST /api/organizer/events` valid payload | 201, status `draft`, unique slug |
| 8 | Event editing | `PUT /api/organizer/events/:id` | 200; bad fields → 422 |
| 9 | Event deletion | `DELETE /api/organizer/events/:id` (draft only) | 200; past orders block it |
| 10 | Poster upload | `POST /api/organizer/events/:id/poster` multipart field `file` (jpg/png/webp ≤ 5 MB) | 200, `poster_url` + `poster_key` set, object in R2 |
| 11 | Poster upload rejects | wrong MIME or > 5 MB | 422, nothing stored |
| 12 | Poster replacement | upload again | old object deleted, new key stored |
| 13 | Poster deletion | `DELETE /api/organizer/events/:id/poster` | R2 object removed, fields cleared |
| 14 | Poster serving | `GET /media/events/<id>/<file>.jpg` | 200 + cache headers; `../` traversal rejected |
| 15 | Ticket type create | `POST /api/organizer/events/:id/tickets` | price stored as integer KES; integer validation enforced |
| 16 | Ticket type auth | organizer B's token on `PUT /api/organizer/tickets/<A's type id>` | 403/404 |
| 17 | Ticket type sales window | `sales_end` in the past on public listing | type not purchasable |
| 18 | Payment settings save | `PUT /api/organizer/payment-settings` | credentials encrypted at rest; GET returns masked hint only |
| 19 | Paystack test connection | `POST /api/organizer/payment-settings/test` | valid key → ok; bad key → clear error, nothing saved as connected |
| 20 | Server-side pricing | `POST /api/orders` with tampered client total/price | amount recomputed from D1; client value ignored |
| 21 | Inventory availability | `POST /api/orders` quantity > remaining | 409, no order created |
| 22 | Expired hold cleanup | abandon a pending order past TTL | `releaseExpiredOrders` frees inventory, order `failed` |
| 23 | Paystack initiate | `POST /api/payments/paystack/initiate` | `checkout_url` (authorization_url) returned; payment row `pending` |
| 24 | Paystack webhook (valid) | signed `charge.success` | server-side verify → payment `success`, order `paid`, tickets generated |
| 25 | Webhook signature | tampered `x-paystack-signature` | 401, **no state change** |
| 26 | Webhook amount/currency | verified amount ≠ order total | payment not marked success; flagged for review |
| 27 | Duplicate webhook | replay the same event twice | 200 both times; ticket count unchanged (idempotent) |
| 28 | Pesapal initiate | `POST /api/payments/pesapal/initiate` | redirect URL returned; payment row `pending` |
| 29 | Pesapal IPN (completed) | IPN → transaction-status `COMPLETED` | verified → paid → tickets issued |
| 30 | Pesapal IPN (not final) | status `PENDING`/`FAILED` | order stays `pending`, no tickets |
| 31 | Duplicate IPN | replay | idempotent, no duplicate tickets |
| 32 | Payment status poll | `GET /api/payments/:reference` | reflects server-verified state only |
| 33 | Ticket fetch | `GET /api/tickets/:ticketNumber` | public-safe fields only |
| 34 | Ticket generation idempotency | force mark-paid twice | one ticket per ordered unit, no duplicates |
| 35 | QR check-in (valid) | `POST /api/check-in` `{ "qr_token": "<real>" }` | `VALID`, `checked_in=1`, timestamp set |
| 36 | Duplicate check-in | same token again | `TICKET ALREADY USED` + original check-in time |
| 37 | Unpaid ticket check-in | ticket whose order is `pending` | rejected — payment status verified server-side |
| 38 | Check-in permission | event-X staff scanning an event-Y ticket | 403 |
| 39 | Owner authorization | organizer token on any `/api/owner/*` | 403 |
| 40 | Owner endpoints | owner token | platform-wide stats/lists; no secrets in any response |
| 41 | Invalid input | malformed JSON, missing/oversized fields | 400/422 with friendly messages; no stack traces |
| 42 | Rate limiting | burst sensitive endpoints from one IP | 429 after the configured window |
| 43 | Organizer cannot self-publish | `POST /api/organizer/events` or `PUT /api/organizer/events/:id` with `status: "active"` | stored `pending`, never `active`; `message` says it is waiting for approval |
| 44 | Approval request mail | same request, as an organizer | `email_outbox` row `event_pending_approval` to every `role='owner'`, `status='active'` user; no `event_published` |
| 45 | Pending stays private | `GET /api/events/:slug` for a `pending` event | 404 — it is absent from `GET /api/events` too |
| 46 | Owner approves | `PUT /api/owner/events/:id` `{"status":"active"}` with an owner token | stored `active`; organizer gets `event_published`; organizer token on the same route → 403 |
| 47 | Owner sends back | `PUT /api/owner/events/:id` `{"status":"draft","reason":"…"}` | stored `draft`; organizer gets `event_changes_requested` with the reason |
| 48 | Approval needs tickets | submit or approve an event with no active ticket type | 409 `NO_TICKETS`, nothing published |

Regression safety net used during development: the full router was executed in a
real Chromium engine against an in-memory `DB`/`BUCKET` shim — 50/50 contract,
auth, CORS, inventory, idempotency and check-in tests passed before delivery.


### 2.2 Endpoint map actually used by the frontend

| Page                        | Calls |
|-----------------------------|-------|
| `login/index.html` / `register/index.html` | `GET /api/me` (post-auth bootstrap) |
| `index.html`, `events/index.html` | `GET /api/events?status=active&q=&category=&featured=…` |
| `event/index.html`                | `GET /api/events/:slug`, `GET /api/events/:id/tickets` |
| `checkout/index.html`             | `POST /api/orders`, `POST /api/payments/paystack/initiate` or `POST /api/payments/pesapal/initiate` |
| `payment-success/index.html`      | `GET /api/payments/:reference` |
| `ticket/index.html`               | `GET /api/tickets/:ticketNumber` |
| `organizer-dashboard/index.html`  | `GET /api/organizer/dashboard` |
| `organizer-events/index.html`, `create-event/index.html`, `edit-event/index.html` | `GET/POST/PUT/DELETE /api/organizer/events…`, `POST /api/organizer/events/:id/poster` (multipart `file`) |
| `ticket-types/index.html`         | `GET/POST/PUT/DELETE /api/organizer/events/:id/tickets`, `/api/organizer/tickets/:id` |
| `orders/index.html`               | `GET /api/organizer/orders?event_id=&status=&q=` |
| `orders/index.html` (Details)     | `GET /api/organizer/orders/:id` (organizer-scoped, 404 for another tenant) |
| `attendees/index.html`            | `GET /api/organizer/attendees?event_id=&checkin=&q=`, `…&format=csv` for export |
| `check-in/index.html`             | `POST /api/check-in` with `{ code, event_id, mode: "lookup" }` for read-only manual lookup; confirm uses the same endpoint without lookup mode to check in |
| `organizer-settings/index.html`   | `PUT /api/organizer/profile`, `POST /api/organizer/logo` (multipart `logo`), payment settings endpoints |
| `owner-*.html`              | `GET /api/owner/dashboard`, `/api/owner/organizers`, `/api/owner/events`, `/api/owner/orders`, `/api/owner/users` |

### 2.3 Public endpoints (no token)

`GET /api/events`, `GET /api/events/:slug`, `GET /api/events/:id/tickets`,
`GET /api/categories`, `GET /api/health`, `GET /media/:key`, and the webhook/IPN
routes are reachable without authentication. Everything else requires a valid
Firebase ID token **and** a matching D1 user in `active` status.

### 2.4 Event publishing needs owner approval

`events.status` is `draft | pending | active | paused | ended | cancelled`, and
`active` — the only status the public site lists — is **owner-only**:

| Step | Request | Stored | Mail |
|------|---------|--------|------|
| Organizer publishes | `POST /api/organizer/events` `status:"active"`, or `PUT /api/organizer/events/:id` `{"status":"active"}` | `pending` | `event_pending_approval` → every active owner |
| Owner approves | `PUT /api/owner/events/:id` `{"status":"active"}` | `active` | `event_published` → the organizer |
| Owner sends back | `PUT /api/owner/events/:id` `{"status":"draft","reason":"…"}` | `draft` | `event_changes_requested` → the organizer, quoting the reason |

- `organizerEventStatus()` is the single gate: any non-owner write of `active`
  becomes `pending`, so the frontend cannot publish by itself. The platform owner
  is the approver, so their own events keep the status they ask for.
- The approval mail goes to every `users` row with `role='owner'` and
  `status='active'` (`approvalRecipients()`), falling back to the platform
  support address so a request is never lost. It is queued once per submission:
  the dedupe key is `event_pending_approval:<event id>:<updated_at>` and it is
  only sent when the event *enters* `pending`.
- The same owner list (`platformOwnerRecipients()`) is reused by the contact form:
  every `POST /api/contact` submission is emailed to those owners as well as to
  the support address, so whoever can act on a message always receives it.
- `409 NO_TICKETS` guards both ends: an event needs at least one active ticket
  type before it can be submitted for approval (`routeOrganizerEvent`) and
  before it can be approved (`routeOwnerEvents`).
- `pending` is invisible to customers: `routePublicEvents` only reads
  `active`/`sold_out`, and `routePublicEvent` 404s anything else.
- `PUT /api/owner/events/:id` answers `submitted`-aware messages
  (`submitted_for_approval` on the organizer routes) so the pages can explain
  what actually happened.
### 2.5 The organizer agreement is a precondition of publishing (migration 0008)

A signed **Digital Organizer Agreement** now gates every publication. The rule lives
in the Worker and nowhere else: the browser is never trusted, and there is no
administrative override — not even for the platform owner.

**Data model (migration 0008, also in `worker/schema.sql`)**

| Table | Holds |
|-------|-------|
| `platform_agreements` | one row per agreement **version**; exactly one `active` (partial unique index); an activated version is immutable |
| `organizer_agreements` | the signature: exact text + exact fee config snapshot, signatory, UTC instant, `AGR-<year>-<code>` reference, `document_key` / `document_sha256`. `UNIQUE(organizer_id, agreement_id)` |
| `agreement_invitations` | single-use, organizer-specific signing tokens; only the **SHA-256 hash** is stored; `expires_at` = issue + 24 h; `status: pending|used|expired|revoked` |
| `agreement_audit_log` | append-only trail (`invitation_issued`, `agreement_viewed`, `agreement_signed`, `document_generated`, `document_downloaded`, `agreement_activated`, `reminder_sent`, `publication_blocked`). Hashed IP only |

`events.agreement_id` / `events.agreement_version` record which version governed an
event **when it was published**, so an already-live event keeps its original terms.

**The gate — `requireAgreementForPublish()`**

Called from exactly three places, all of which end in `status='active'`:

| Path | What is checked |
|------|-----------------|
| `POST /api/organizer/events` | creating an event that publishes now, or is submitted for approval |
| `PUT /api/organizer/events/:id` | moving an event that is **not** already on the publication track (`draft`/`paused`/`ended`/`cancelled` → `active`/`pending`) |
| `PUT /api/owner/events/:id` | approving/publishing — checked against the **event's organizer**, never the acting owner's own account |

A refusal is `403 AGREEMENT_REQUIRED` with machine-readable `details`
(`agreement_status`, `agreement_version`, `signed_version`, `agreement_url`,
`publication_blocked`, `blocked_path`), and it is audited. Editing an already-published
event, pausing, cancelling and ending are never gated — only publication is.

Statuses: `signed | pending | outdated | revoked | not_configured`. It **fails
closed**: no active version, an unreadable signature or a database error all mean
`can_publish = false`.

**Organizer routes** (`/api/organizer/agreement…`)

| Route | Purpose |
|-------|---------|
| `GET  /api/organizer/agreement` | current version, text, fee terms, state, last signature, pending invitation |
| `GET  /api/organizer/agreement/status` | the same state without the document (for banners) |
| `POST /api/organizer/agreement/invite` | issue a fresh single-use link for this organizer and email it (also returns the review URL) |
| `GET  /api/organizer/agreement/verify?token=` | the exact text behind a link, before anything can be signed |
| `POST /api/organizer/agreement/sign` | accept: `{token, signatory_name, signatory_role, signature_image, agreed:true}`; `signature_image` is a PNG data URL of the drawn mark |
| `GET  /api/organizer/agreement/document` | the organizer's own signed copy (streamed from R2 through the Worker; the key is never exposed) |

**Owner routes** (registered under both `/api/admin/agreements…` and
`/api/owner/agreements…`, owner role only)

| Route | Purpose |
|-------|---------|
| `GET /api/admin/agreements` | every version, signature counts, unsigned coverage |
| `POST /api/admin/agreements` | create a **draft** version (`version`, `title`, `content`, `summary`, `effective_date`, `fee_config`) |
| `PATCH /api/admin/agreements/:id` | edit a draft only — an activated version answers `409 AGREEMENT_IMMUTABLE` |
| `POST /api/admin/agreements/:id/activate` | supersede the previous version, activate this one, notify organizers |
| `POST /api/admin/agreements/:id/invite` | send one organizer their single-use link (the token travels by email only) |
| `POST /api/admin/agreements/:id/remind` | one reminder per unsigned organizer per day |
| `GET /api/admin/agreements/:id/signatures` | who accepted, when, under which reference |
| `GET /api/admin/agreements/audit` | the append-only trail |
| `GET /api/owner/organizers/:id/agreement/document` | owner-only download of that organizer's signed HTML copy; returns `404 NO_SIGNED_AGREEMENT` when unsigned |

**Mail** (Brevo, four new templates): `organizer_agreement_invitation`,
`organizer_agreement_signed`, `organizer_agreement_updated`, `organizer_agreement_reminder`.

**Money**: `platformFeeForAmount()` computes the accepted fee terms server-side for
display and reporting. No order, price or payment row is touched by this feature —
existing orders keep their amounts.

**Operational note**: run migration 0008 **before** this Worker is deployed, then
create and activate the first version in the owner dashboard. Until a version is
active, publishing is refused on purpose (fail closed).
