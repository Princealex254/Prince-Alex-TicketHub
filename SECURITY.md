# Security

Prince Alex TicketHub is a static frontend (Cloudflare Pages) plus one Cloudflare
Worker API backed by D1 and R2. This document is the security model, what is
already enforced in code and configuration, and what still depends on your
Cloudflare account settings.

---

## 1. Reporting a vulnerability

Email **support@princealex.digital** with steps to reproduce. Please do not open
a public issue or test against production data. We aim to acknowledge within a
few business days. Never include live secrets, ID tokens or customer data in a
report.

---

## 2. The trust model

> The browser is **never** trusted. Every value that decides money, access or a
> ticket is derived server-side from D1 or from the payment provider.

- Firebase ID tokens are verified **cryptographically** (RS256 against Google's
  JWKs, with `iss`/`aud`/`exp`/`iat` checks and a one-time key refresh on an
  unknown `kid`). Token payloads are never trusted on their own.
- Money is recalculated from D1 on every order; a browser-supplied price,
  quantity or total is ignored.
- An order is marked **paid** and tickets are issued on exactly one path
  (`markOrderPaid`), and only after the provider's own verification agrees on
  amount, currency and reference. A replayed webhook changes nothing.
- Payment credentials are stored **AES-GCM encrypted** (key =
  `PAYMENT_ENCRYPTION_KEY`) and are never returned to any client; the API returns
  booleans such as `has_secret_key`, never the secret.

---

## 3. Payments

Two layers, in order: **authenticate the callback**, then **ask the provider**.

| Provider | Callback authenticity | Final authority |
| --- | --- | --- |
| Paystack | HMAC-SHA512 over the raw body, compared in constant time | `GET /transaction/verify/:reference` |
| Pesapal | IPN is unsigned → followed by `GetTransactionStatus` | `GetTransactionStatus` (amount + merchant reference) |
| PayHero | Basic auth when present → followed by `TransactionStatus` | `TransactionStatus` |

After verification, `PaymentService.validatePayment()` refuses a success unless
the **amount** matches the stored order total and the **currency** matches, and
the callback's reference is compared with the one this server issued. Only then
does `markOrderPaid()` run its single, idempotent state transition
(`... WHERE status != 'paid'`) and issue tickets.

Other money-safety properties:

- Free orders never touch a gateway, but when email verification is on for the
  event, only an order created by the verified free-registration flow (an
  `active` claim row) can be settled.
- Expired unpaid orders release their inventory automatically and never issue
  tickets.
- Settlement and webhooks always use the credentials of **the transaction's own
  provider/organizer**, even if the organizer later switches provider.
- Refunds report honestly: a provider without automated refunds returns a clear
  "record it in the provider dashboard" error instead of pretending.

---

## 4. Bot and abuse protection

- **Turnstile** is required on every public write surface: organizer
  registration, sign-in, password reset, event creation, checkout, the contact
  form and the free-ticket email-verification flow. Verification is server-side
  (siteverify) with **hostname**, **action** and **single-use** checks; a token
  is hashed and marked used so it cannot be replayed.
- The checkout second step (asking the gateway for a URL) is authorised by a
  short-lived **HMAC receipt** bound to the order reference and the client IP,
  so a single-use Turnstile token is not the only thing standing between a bot
  and a payment session.
- **Layered rate limiting** runs before any protected work, in one policy table
  (`RATE_POLICIES`): per-isolate memory → optional Cloudflare native binding →
  authoritative D1 counters. Identities are IP, Firebase UID, hashed email and
  order reference; several tiers apply to one request, so rotating IPs still
  hits the account tier and rotating accounts still hits the IP tier. The D1
  tier is a single atomic `INSERT … ON CONFLICT DO UPDATE` inside `env.DB.batch()`,
  so concurrent requests cannot both act on a pre-increment count.
- Emails are hashed before they reach a limiter or a log; `rate_key` is a
  SHA-256 hash, so no IP, UID or address is stored in the counter table.
- Over-limit requests answer `429` + `Retry-After` with a message that never
  reveals which limit was hit.
- The free-ticket OTP uses `crypto.getRandomValues()` with rejection sampling,
  a short TTL, a capped attempt counter incremented **before** the constant-time
  compare, one-time resend limits, and hashed (never stored) codes and tokens.

Broad traffic shaping (DDoS, scanners, credential stuffing across many IPs) is
best finished at the edge — see §6.

---

## 5. Web application hardening

- **SQL**: every D1 query is parameterised (`?` bindings). The only dynamic SQL
  fragments are literal column names chosen in code, never request input.
- **XSS**: text is HTML-escaped (`esc`) in email templates; pages build DOM with
  `textContent`/`createElement`. There are no inline event handlers and no
  `eval`/`new Function`. A strict CSP (below) is the net for anything missed.
- **IDOR / access control**: `requireAuth`, `requireOwner` and `eventAccess`
  enforce owner/organizer/staff boundaries on every protected route; staff are
  restricted to their assigned events.
- **Media**: `/media/:key` only serves keys matching the pattern the Worker
  itself generates, so the R2 bucket cannot be walked; responses are `nosniff`.
- **Enumeration**: order and ticket numbers carry a 10-character random suffix.
- **Error hygiene**: 5xx responses expose a stable, non-sensitive code (e.g.
  `DB_SCHEMA`) and a generic message; secrets, tokens and credential material are
  never logged.
- **CORS**: an allow-list with default-deny; the request `Origin` is echoed only
  when it is on the list (or `ALLOWED_ORIGINS` contains `*`). Only
  `CF-Connecting-IP` is trusted as the client IP.
- **Secrets**: all keys live in Worker secrets / `app_settings`; the Firebase web
  config in `firebase.js` is public by design and cannot grant access on its own.

### Static-host headers (this repo)

`_headers` (read by Cloudflare Pages) applies to every page:

`Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
`Permissions-Policy`, `Cross-Origin-Opener-Policy`,
`Cross-Origin-Resource-Policy`, and a strict `Content-Security-Policy`
(`default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`,
`base-uri 'self'`), allow-listing only `www.gstatic.com` (Firebase SDK),
`challenges.cloudflare.com` (Turnstile) and the API Worker origin.
`camera=(self)` is kept on purpose so ticket QR check-in keeps working.
Preview URLs (`*.pages.dev`) are marked `noindex`.

`_redirects` proxies `/worker/*`, `/tools/*` and the dev/test harnesses to the
homepage, so the backend source, the schema and the check pages are **never**
served from the public site.

> Keep both files at the publish root and deploy the folder as-is — they are
> what make the above actually apply.

**Maintenance rules for these two files:**

- `_headers` must contain **no `#` comment lines**. It is validated with the rule
  set that every line is either a path pattern (starts in column 1) or an
  indented `Name: value` header. A `#` line in `_redirects` is a comment; the
  same line in `_headers` risks the whole file failing to parse, and Pages
  silently serves **no security headers at all** with no error anywhere.
- The rule block must stay contiguous: **no blank lines inside a pattern's
  header list**, only between patterns.
- `_redirects` **does** accept `#` comments. Its hardening rules are listed
  **first**, because a redirect chain stops at the first match — keep new
  suppressions at the top.
- Neither file may be moved into a subfolder; both are only read at the
  publish root.
- `img-src` allows `https:` broadly on purpose: poster/logo URLs are stored in
  D1 by `mediaUrlFor()` and rendered as-is, so the origin can change when
  `API_BASE` changes. Narrow it to `https://*.workers.dev` only once every
  stored `poster_url` has been confirmed to use the current Worker origin.

---

## 6. Recommended account-level controls (Cloudflare)

These sit outside the code and are the remaining step for "safe from all
attacks":

1. **WAF** with the Cloudflare Managed Ruleset enabled, plus a rate-limiting rule
   on `*/api/*` (e.g. 300 req/min per IP) and a stricter one on `/api/check-in`.
2. **Bot Fight Mode / Turnstile** at the edge, in addition to the in-app
   challenges.
3. **Native `RATE_LIMITER` binding** (Workers Paid) — the Worker already consults
   it automatically when bound (see `worker/wrangler.toml`).
4. Leave **`CF-Connecting-IP`** untouched (no proxy that overwrites it), so
   rate-limit tiers key on the true client.
5. **D1 + R2 least privilege**, and a cron trigger on the Worker so the email
   outbox and expired rate-limit rows are swept even on a quiet day.

---

## 7. Configuration that must be set, in order of impact

| Secret / var | Why it matters |
| --- | --- |
| `TURNSTILE_SECRET` | Turns on the bot checks. Without it challenges are skipped (logged once). |
| `FIREBASE_PROJECT_ID` | Without it, all authenticated calls fail closed. |
| `PAYMENT_ENCRYPTION_KEY` | Required before any organizer connects payments (≥16 chars). |
| `BREVO_API_KEY` | Required to send any email; without it the queue simply grows. |
| `ALLOWED_ORIGINS` / `FRONTEND_URL` | CORS allow-list and the links inside emails. |

Unknown env vars are ignored and never trusted; the full list the Worker reads
is documented in `worker/README.md` §1.


