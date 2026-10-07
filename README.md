# Prince Alex TicketHub

**Powered by Prince Alex Digital**

A production-ready event ticketing SaaS frontend for the Kenyan market, built as 32 standalone HTML pages (inline CSS + inline vanilla JavaScript, no build system, no
frameworks), sharing one small firebase.js that holds the Firebase web configuration and the
common Auth helper loaded by every page.
It is designed to connect directly to a Cloudflare Worker API backed by Cloudflare D1,
Cloudflare R2, Firebase Authentication, Cloudflare Turnstile, Pesapal and Paystack.

---

## 1. Architecture

```
Customer / Organizer / Staff browser
  |  Firebase ID token (organizers, staff, owner)
  v
Standalone HTML pages  ->  Cloudflare Worker API  ->  Cloudflare D1 (data)
                                                  ->  Cloudflare R2 (event posters, logos)
                                                  ->  Paystack (payments)
                                                  ->  Firebase Admin (token verification)
                                                  ->  Cloudflare Turnstile (bot protection)
```

Rules that the frontend obeys:

- Ticket prices, totals, availability and payment status are decided **server side** only.
- A payment is never treated as successful because the browser returned from Paystack.
  `payment-success/index.html` asks the Worker (`GET /api/payments/:reference`), which verifies the
transaction with Paystack and reads the confirmed state from D1.
- Ticket QR codes contain a random ticket token only. Names, emails and phone numbers are never
  encoded into the QR image; `ticket/index.html` loads the image from the Worker.
- No secret ever appears in frontend code: no Paystack secret key, no Firebase Admin credentials,
  no R2 keys, no Cloudflare API tokens.

---

## 2. Page inventory (all standalone HTML)

Public website:

| File | Purpose |
| --- | --- |
| `index.html` | Full-bleed hero image (background) with search, categories, featured events, upcoming events, organizer CTA, trust section |
| `events/index.html` | Event discovery with hero background image (hero2.png), search + category filters, sorting, pagination |
| `event/index.html` | Event details + ticket selection with inventory limits and sold out / sales closed / ended states |
| `checkout/index.html` | Customer details, Worker-validated order creation, Paystack redirect |
| `payment-success/index.html` | Polls the Worker for the verified payment status, shows order summary, tickets, download and email actions |
| `payment-failed/index.html` | Honest failure/incomplete state with helpers, never claims a ticket was issued |
| `ticket/index.html` | Digital ticket with poster, attendee, ticket type, ticket number PAT-XXXXXXXX and QR image |
| `check-ticket/index.html` | Confirm a ticket: the email used to book and the Order ID are matched together by the Worker (`POST /api/orders/lookup`), then the order, its issued tickets and a link to each QR view |
| `organizer/index.html` | For organizers marketing page |
| `login/index.html` | The one sign-in door for organizers, event staff and the platform owner; the Worker role decides the dashboard |
| `register/index.html` | Organizer registration (Firebase + D1 profile, Turnstile) |
| `forgot-password/index.html` | Firebase password reset |
| `about/index.html`, `contact/index.html`, `terms/index.html`, `privacy/index.html` | Company, support (Worker backed form) and legal pages |

Organizer and admin area:

| File | Purpose |
| --- | --- |
| `organizer-dashboard/index.html` | Totals, recent events, quick actions, agreement banner |
| `organizer-agreement/index.html` | Read the organizer agreement + platform fee terms, sign it, download the signed copy |
| `create-event/index.html` | Create event as draft, poster upload with preview and validation |
| `edit-event/index.html` | Edit event, replace poster, change status, cancel event |
| `organizer-events/index.html` | Event list with filters and pagination |
| `ticket-types/index.html` | Ticket types (Early Bird / Regular / VIP), integer KES pricing, sales windows |
| `orders/index.html` | Orders with filters, order-details overlay, CSV export |
| `attendees/index.html` | Attendee list with filters and Worker-driven CSV export |
| `check-in/index.html` | QR scanner (BarcodeDetector + camera), manual lookup, session log |
| `organizer-settings/index.html` | Organizer profile, logo upload, payment settings (Paystack/Pesapal connect + test), password reset |

Platform owner area (sign in at `login/` with the owner account):

| File | Purpose |
| --- | --- |
| `owner-dashboard/index.html` | Organizers, events, tickets sold, gross sales, platform revenue, pending payments, organizer agreement versions |
| `owner-organizers/index.html` | Organizer accounts with activate / suspend / reject |
| `owner-events/index.html` | All events, feature and pause toggles |
| `owner-orders/index.html` | Platform-wide orders with totals and CSV export |
| `owner-settings/index.html` | Platform configuration (fees, prefix, featured limit, Turnstile, maintenance) |

Supporting files: `worker/index.js` (Cloudflare Worker API), `worker/schema.sql` (Cloudflare D1
schema), `worker/README.md` (deployment, payment setup and testing checklist), `firebase.js`
(shared Firebase web config + Auth helper).

---

## 3. Configuration

Every page has a clearly marked configuration block at the top of its `<script>` section:

```js
const API_BASE = "https://YOUR-WORKER-DOMAIN.workers.dev";
const FIREBASE_CONFIG = {
  apiKey: "YOUR_FIREBASE_API_KEY",
  authDomain: "YOUR_FIREBASE_AUTH_DOMAIN",
  projectId: "YOUR_FIREBASE_PROJECT_ID",
  appId: "YOUR_FIREBASE_APP_ID"
};
const TURNSTILE_SITE_KEY = "0x4AAAAAAFFfPC7TnnFT83yZ";   // public; the secret stays in the Worker
```

The site key above is already set on the protected pages (`register/`, `login/`,
`forgot-password/`, `contact/`, `checkout/`, `create-event/`).
Pages that never submit a form still carry the unused `YOUR_TURNSTILE_SITE_KEY`
placeholder.

- Set `API_BASE` to your Worker URL for every page (a global search and replace works well).
- Pages fall back gracefully while placeholders remain: discovery pages show a neutral "not connected
yet" notice instead of fake data, and sensitive actions explain that the service is not connected.
- Firebase is loaded with a native dynamic `import()` from the Firebase CDN at the moment a page
needs it, so no bundler is required. If Firebase is unreachable, the pages still render.
### Deploying the Worker: dashboard vs wrangler

The API is a module pair (`worker/index.js` imports `./emails.js`). With **wrangler**
(see `worker/wrangler.toml`, `main = "index.js"`) both files upload and the import
resolves. The **Cloudflare dashboard code editor** deploys a single module named
`worker.js`, so pasting `index.js` alone fails with
`No such module "emails.js". imported from "worker.js"`. For that path, run
`worker\build-single-file.ps1` (or `worker\build-single-file.cmd`) and paste the
generated `worker/worker.js` instead — it inlines `emails.js` and reads the same
bindings and secrets. Details: [`worker/README.md`](worker/README.md) §1.5.



---

## 4. Worker environment (secrets live here, never in the browser)

The Worker and its environment are documented in full in
[`worker/README.md`](worker/README.md) §1.3–1.4 — that file is the source of truth.
Summary of every name the Worker actually reads from `env`:

| Name | Kind | Required? | Purpose |
| --- | --- | --- | --- |
| `DB` | Cloudflare D1 binding | **Yes** | every route |
| `BUCKET` | Cloudflare R2 binding | **Yes** | posters/logos, `GET /media/:key` |
| `FIREBASE_PROJECT_ID` | var or secret | **Yes** | verifies Firebase ID tokens (Google JWKs) |
| `ALLOWED_ORIGINS` | var | **Yes** | CORS allow-list, comma-separated; `*` = echo any origin |
| `FRONTEND_URL` | var | Recommended | added to the CORS allow-list **and** the payment return URL |
| `PAYMENT_ENCRYPTION_KEY` | secret | Yes, before an organizer saves merchant credentials | AES-GCM key for stored Paystack/Pesapal secrets |
| `PAYSTACK_SECRET_KEY` | secret | Optional | platform-level Paystack fallback for checkout |
| `PESAPAL_CONSUMER_KEY` / `PESAPAL_CONSUMER_SECRET` | secret | Optional | platform-level Pesapal fallback |
| `PESAPAL_ENV` | var | Optional | `sandbox` (default) or `live` |
| `TURNSTILE_SECRET` | secret | Yes, to enforce bot protection | server-side Turnstile verification (hostname + action + single use); skipped when unset, with one `turnstile_not_configured` warning per isolate. The old name `TURNSTILE_SECRET_KEY` is still read |
| `TURNSTILE_HOSTNAMES` | var | Optional | csv of hostnames allowed to solve a challenge; defaults to `tickethub.princealex.digital`, the Worker's own origin and local dev hosts |
| `RATE_*_LIMIT` / `RATE_*_WINDOW` | var | Optional | plain-text overrides for any rate-limit tier, e.g. `LOGIN_LIMIT=5`, `LOGIN_WINDOW=900`, `CHECKOUT_LIMIT=10`, `CONTACT_EMAIL_LIMIT=3`, `ORDER_LOOKUP_IP_LIMIT=120`. Defaults live in one table (`RATE_POLICIES`) in `worker/index.js`; the counters themselves live in the D1 table `rate_limits` |
| `BREVO_API_KEY` | secret | Yes, to send any email | Brevo transactional key (`xkeysib-…`). Every mail is written to the `email_outbox` table first and then relayed through `POST https://api.brevo.com/v3/smtp/email` by `worker/emails.js`. Without it the queue simply grows - nothing is lost |
| `EMAIL_FROM` / `EMAIL_FROM_NAME` / `EMAIL_REPLY_TO` | var | Optional | Fallback sender address, display name and reply-to, used when `app_settings.email_from_email` / `email_from_name` / `email_reply_to` are not set in *Owner → Settings* |
| `EMAIL_DISABLED` | var | Optional | `true` pauses all outbound mail (handy while staging) |
| `SUPPORT_EMAIL` | var | Optional | Last-resort sender/contact address when nothing else is configured |

**Do not create these** — older notes list them, but nothing in the Worker reads them:
`FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (ID tokens are verified against
Google's public JWKs), `PAYSTACK_WEBHOOK_SECRET` (the webhook signature is verified
with the secret key), `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` /
`R2_BUCKET` (R2 is reached through the `BUCKET` binding), `MEDIA` (the binding is named
`BUCKET`), `APP_BASE_URL`. Rate limiting is in-memory per isolate,
so no KV namespace is required. The HTTP header names (`Access-Control-Allow-Origin`
and friends) are produced by the code and are not variables.

---

## 5. API contract used by the frontend

### Public

| Method | Endpoint | Used by | Expected response |
| --- | --- | --- | --- |
| GET | `/api/events?status=active&q=&category=&location=&date=&max_price=&sort=&featured=&page=&limit=` | `index.html`, `events/index.html` | `{ events: [...], meta: { page, limit, total } }` - each event needs `id, slug, title, category, venue, location, event_date, start_time, poster_url, starting_price, status, is_featured` |
| GET | `/api/events/:slug` | `event/index.html`, `checkout/index.html` | `{ event: {...} }` including `description, end_time, sales_start, sales_end, organizer_name` |
| GET | `/api/events/:id/tickets` | `event/index.html`, `checkout/index.html`, `ticket-types/index.html`, `attendees/index.html` | `{ tickets: [{ id, name, description, price (integer KES), quantity, sold, available, sales_start, sales_end }] }` |
| GET | `/api/categories` | `index.html`, `events/index.html`, `create-event/index.html`, `edit-event/index.html` | `{ categories: ["Music", ...] }` or a plain array |
| POST | `/api/contact` | `contact/index.html` | `{ message }` - body: name, email, phone, subject, message, turnstile_token. The message is stored in `contact_messages`, then emailed to the platform support address, to every active platform owner, and back to the sender as an acknowledgement (`owner_notified` reports whether an owner was reached) |
| GET | `/api/tickets/:ticketNumber` | `ticket/index.html` | `{ ticket: { ticket_number, attendee_name, ticket_type_name, status, checked_in_at, order_number, qr_image_url, event: { title, event_date, start_time, end_time, venue, location, poster_url } } }` |
| GET | `/api/tickets/:ticketNumber/qr.png` | `ticket/index.html` (fallback) | PNG QR image encoding only a random ticket token |
| GET | `/api/orders/:reference/tickets` | `ticket/index.html`, `payment-success/index.html` | `{ tickets: [...] }` |
| POST | `/api/orders/lookup` | `check-ticket/index.html` | body: `order_number`, `email` - both matched against the order server side; answers `{ tickets: [...] }` only when they belong together, a generic 404 otherwise |
| POST | `/api/tickets/send-email` | `ticket/index.html`, `payment-success/index.html` | body: ticket_number or order_number, email |

### Orders and payments

| Method | Endpoint | Notes |
| --- | --- | --- |
| POST | `/api/orders` | body: `event_id`, `items: [{ ticket_type_id, quantity }]`, `customer: { full_name, email, phone }`, `turnstile_token` (action `checkout`). The Worker validates availability and **recalculates the amount from D1 prices**. Returns `{ order: { id, order_number, reference, amount, ticket_count }, checkout_proof }` |
| POST | `/api/payments/paystack/initiate` | body: `reference` / `order_id` plus either the `checkout_proof` from the order response or a fresh `turnstile_token`. Creates the Paystack transaction with the server-calculated amount and returns `{ authorization_url }` |
| GET | `/api/payments/:reference` | Returns the **verified** status used by `payment-success/index.html` / `payment-failed/index.html`: `{ status: paid\|pending\|failed\|cancelled\|refunded, order: {...}, tickets: [...] }` |
| POST | `/api/webhooks/paystack` | Server to server. Verifies the signature, re-verifies the transaction with Paystack, updates `payments`/`orders`, generates `tickets`, sends the ticket email |

### Authenticated (Firebase ID token in `Authorization: Bearer <token>`)

| Method | Endpoint | Role |
| --- | --- | --- |
| GET | `/api/me` | any signed-in role - returns `{ id, firebase_uid, full_name, email, phone, role, status, organizer }` |
| POST | `/api/auth/turnstile` | public, rate limited per IP **and** per account - body: `action` (`login`, `password-reset`, `email-verification`), `email`, `turnstile_token`. Firebase sign-in and password reset run in the browser, so the challenge is verified **here first**; the answer is `{ verified: true, enforced, expires_in }` and the token is never stored or echoed back |
| POST | `/api/auth/register` | new organizer - body: full_name, email, phone, business_name, turnstile_token (action `register`, checked before the Firebase token) |
| GET | `/api/organizer/dashboard` | organizer/owner - `{ stats: { total_events, active_events, tickets_sold, gross_revenue }, recent_events: [...] }` |
| GET/POST | `/api/organizer/events` | organizer - list (`q, status, category, when, page, limit`) and create (draft). Creating with `status: "active"` is stored as `pending` and lands in the owner approval queue |
| GET/PUT | `/api/organizer/events/:id` | organizer (own event only) |
| POST | `/api/organizer/events/:id/poster` | organizer - multipart form field `poster` (JPG/PNG/WEBP, max 5 MB) |
| GET/POST | `/api/organizer/events/:id/tickets` | organizer - list/create ticket types |
| PUT/DELETE | `/api/organizer/events/:id/tickets/:ticketId` | organizer |
| GET | `/api/organizer/orders` / `/api/organizer/orders/:id` | organizer - list with `q, event_id, status, from, to, page, limit`; the single-order call returns the order with its `items`, `tickets` (attendee, ticket number, check-in) and event details, scoped exactly like the list, and backs the **Details** overlay on `orders/index.html` |
| GET | `/api/organizer/attendees` | organizer - list with `q, event_id, ticket_type_id, check_in, payment_status, page, limit` |
| GET | `/api/organizer/attendees/export.csv` | organizer - CSV stream (falls back to a JSON list in the page if CSV is not returned) |
| POST | `/api/check-in` | organizer/owner/event_staff - body `{ event_id, code, mode }`, `mode` is `qr` or `manual`. Returns `{ valid, status: valid\|already_checked_in\|invalid, attendee_name, ticket_type_name, ticket_number, checked_in_at, reason }` |
| GET/PUT | `/api/organizer/profile` | organizer profile and business details |
| POST | `/api/organizer/logo` | organizer - multipart form field `logo` |

### Platform owner

| Method | Endpoint | Notes |
| --- | --- | --- |
| GET | `/api/owner/dashboard` | `{ stats: { total_organizers, total_events, active_events, tickets_sold, gross_sales, platform_revenue, pending_payments, checked_in }, recent_orders, recent_organizers, recent_events }` |
| GET | `/api/owner/organizers` | filters `q, status, page, limit` |
| PUT | `/api/owner/organizers/:id` | body `{ status: active\|pending\|suspended\|rejected }` |
| GET | `/api/owner/events` | filters `q, status, featured, when, page, limit` |
| PUT | `/api/owner/events/:id` | body `{ status }` or `{ is_featured }`; `{ status: "active" }` **approves** a `pending` submission (the organizer is emailed), `{ status: "draft", reason }` sends it back with the reason, and an event with no active ticket type cannot be approved |
| GET | `/api/owner/orders` | filters `q, event, status, from, to, page, limit` plus `totals` |
| GET/PUT | `/api/owner/settings` | platform settings object - includes the email fields `email_from_name`, `email_from_email`, `email_reply_to`, `email_enabled` |
| GET | `/api/owner/emails` | Brevo outbox: filters `status`, `template`, `q`, `page`, `limit`; `?status_only=1` returns `{ email: { provider, configured, enabled, sender, sender_name, reply_to, templates }, stats, templates }` |
| GET | `/api/owner/emails/templates` | the registry of every transactional template (key, name, category, description, subject) |
| POST | `/api/owner/emails/dispatch` | body `{ limit }` (max 25) - flushes the queue through Brevo immediately, returns `{ processed, sent, failed, remaining }` |
| POST | `/api/owner/emails/send` | body `{ template, to, data }` - queues (and tries to send) any template on demand |
| POST | `/api/owner/emails/test` | body `{ to }` - renders and sends the branded test email so the API key and sender can be proven end to end |
| POST | `/api/owner/emails/:id/resend` | re-queues a failed outbox row and retries it |

#### Transactional email templates

The **Approved templates** list in Owner → Settings → Transactional email is the Worker’s
built-in allowlist, not a set of templates that owners approve or edit in the dashboard.
Only registered template keys can be rendered and sent; this keeps email content and
trigger behavior controlled by the application. The registry in [`worker/emails.js`](worker/emails.js)
is the source of truth, and the dashboard list is loaded from `/api/owner/emails/templates`.

| Key | Name | Category | Purpose |
| --- | --- | --- | --- |
| `ticket_ready` | Tickets delivered | transactional | Sends the receipt and QR tickets after payment is verified or a free order is settled |
| `ticket_resend` | Tickets resent | transactional | Resends existing tickets when requested by a buyer |
| `order_pending` | Order awaiting payment | transactional | Confirms that an order was created while payment is still pending |
| `free_ticket_otp` | Free ticket verification code | transactional | Verifies the email address claiming a free ticket; contains no QR code |
| `payment_failed` | Payment failed | transactional | Reports a failed or abandoned payment |
| `welcome` | Organizer welcome | transactional | Onboarding email after registration: profile, payment setup, agreement signature and first event approval |
| `new_sale` | New sale (organizer) | transactional | Notifies the organizer of a settled payment, including buyer contact details |
| `contact_message` | Contact form message | internal | Forwards a contact form submission to platform support and active owners |
| `contact_ack` | Contact form acknowledgement | transactional | Confirms receipt of a contact form submission to its sender |
| `event_cancelled` | Event cancelled | transactional | Notifies paid attendees and the organizer when an event is cancelled |
| `event_published` | Event published | transactional | Notifies the organizer when an event goes live, including after owner approval |
| `event_pending_approval` | Event awaiting approval (owner) | internal | Notifies active platform owners when an event is submitted for publishing |
| `event_changes_requested` | Event sent back for changes | transactional | Explains that an owner returned a submitted event for changes |
| `organizer_status` | Organizer account status | transactional | Notifies an organizer when an owner suspends or reactivates the account |
| `refund_processed` | Refund issued | transactional | Confirms a refund issued through the payment provider dashboard |
| `test_email` | Delivery test | internal | Verifies the configured Brevo key, sender, and delivery relay |
| `organizer_agreement_invitation` | Organizer agreement invitation | transactional | Sends a single-use, time-limited invitation to review and sign the active agreement |
| `organizer_agreement_signed` | Organizer agreement signed | transactional | Confirms signing and includes the agreement reference and accepted fee summary |
| `organizer_agreement_updated` | Organizer agreement updated | transactional | Alerts organizers that a new agreement version requires review and acceptance |
| `organizer_agreement_reminder` | Organizer agreement reminder | transactional | Sends one proportionate reminder for an unsigned agreement |

All error responses should be JSON: `{ "message": "Friendly text", "code": "MACHINE_CODE" }` with the proper
HTTP status. The frontend shows `message` for 4xx responses and replaces 5xx/network failures with
"Something went wrong. Please try again." so raw backend errors are never exposed to customers.

---

### Event publishing needs owner approval

Nothing an organizer submits goes live on its own. Setting an event to **Active**
is a request, not a publish:

```
organizer sets status: active  ->  stored as pending  ->  event_pending_approval email to every owner
owner approves   { status: "active" }        -> stored as active -> event_published email to the organizer
owner sends back { status: "draft", reason } -> stored as draft  -> event_changes_requested email with the reason
```

- An organizer (and `event_staff`) can never write `active` directly: the Worker
  stores `pending` for them - on create and on update - so every transition to
  live has been approved. `pending` is never public: `GET /api/events` and
  `GET /api/events/:slug` only read `active`/`sold_out`.
- The platform owner (role `owner`) is the approver, and their own events are
  published directly: they are the approver, so they are not queued for it.
- A submitted event must have at least one active ticket type before it can be
  submitted (`409 NO_TICKETS`) or approved, so nothing can go live with no ticket
  to sell.
- The approval request is queued to every `users` row with `role = 'owner'` and
  `status = 'active'` (falling back to the platform support address), and it is
  idempotent per submission: re-saving a pending event does not send a second
  request, because the dedupe key is the event id plus its `updated_at`.
- `owner-events/index.html` shows the queue (`Status → Pending approval`) with
  **Approve** and **Request changes** buttons; the organizer sees the same status
  in `organizer-events/index.html` and `edit-event/index.html`.

### 5.1 Organizer agreement — publishing requires a signature (migration 0008)

Publishing has one more precondition before it: the organizer must have accepted
the organizer agreement and platform fee terms that are currently in force.

```
unsigned or outdated signature -> 403 AGREEMENT_REQUIRED (with details) -> nothing is published
signed signature               -> the request proceeds exactly as before
```

- The rule is enforced **in the Worker**, on every path that can make an event
  live: organizer create, organizer update, and owner approval (checked against
  the event's organizer). There is no override flag and no admin shortcut.
- Signing is a single-use, 24-hour, organizer-specific link. Only the SHA-256
  hash of the token is stored, the link is bound to the authenticated account,
  and the signature keeps the exact text and fee configuration that were accepted.
- Drafts, editing, pausing, cancelling and ending never need the agreement; only
  publication does. Events that were already live keep the terms they were
  published under (`events.agreement_id` / `agreement_version`).
- Activating a new version makes every organizer re-accept; the old signatures are
  kept as history. An activated version can never be edited — a change is a new version.
- Owner pages: `owner-dashboard/index.html` → **Organizer agreement** (versions,
  drafts, activation, invitations, reminders). Organizer pages:
  `organizer-agreement/index.html`, plus a banner on `organizer-dashboard/` and a
  locked status control on `edit-event/`.
- Full detail, routes and tables: `worker/README.md` §2.5.

---

## 6. Payment flow (server authoritative)

```
checkout.html
  -> POST /api/orders                 (Worker validates availability, recalculates amount, stores pending order)
  -> POST /api/payments/paystack/initiate  (Worker creates the Paystack transaction with the D1 amount)
  -> Paystack checkout (card / M-Pesa / mobile money)
  -> POST /api/webhooks/paystack      (Worker verifies signature, re-verifies transaction, marks paid)
  -> tickets generated in D1 + ticket email sent
  -> payment-success.html polls GET /api/payments/:reference until the verified status arrives
  -> ticket.html shows the digital ticket and QR code
```

`payment-success/index.html` retries up to 7 times (4 s apart) and tells the customer not to pay again while
confirmation is pending.

---

## 7. Data model

See `worker/schema.sql` for the full Cloudflare D1 schema (13 tables, 32 indexes). Core tables:

- `users` - `firebase_uid, full_name, email, phone, role (owner|organizer|event_staff), status (active|suspended|deleted)`
- `organizers` - `user_id (UNIQUE), business_name, business_email, business_phone, logo_url, status (active|suspended)`
- `events` - `organizer_id, title, slug (UNIQUE), description, category, venue, location, event_date, start_time,
  end_time, poster_url, poster_key, status (draft|pending|active|paused|ended|cancelled), is_featured,
  sales_start, sales_end`
- `ticket_types` - `event_id, name, description, price (INTEGER KES), quantity, sold, sales_start, sales_end, status (active|paused|hidden)`
- `payment_settings` - per-organizer provider choice (`paystack|pesapal`), `public_key`, AES-GCM encrypted
  `secret_key_encrypted` / `consumer_secret_encrypted`, `ipn_id`, `status (not_connected|connected|error)`
- `orders` - `order_number (UNIQUE), event_id, organizer_id, customer_name/email/phone, total_amount
  (INTEGER KES), currency, status (pending|paid|failed|cancelled|refunded), inventory_held, paid_at`
- `order_items` - `order_id, ticket_type_id, quantity, unit_price, subtotal` (prices snapshotted from D1)
- `payments` - one row per payment attempt: `order_id, provider (paystack|pesapal), reference (UNIQUE),
  provider_ref, amount, status (pending|success|failed|abandoned|reversed), paid_at, provider_response`
- `tickets` - `ticket_number (PAT-XXXXXXXX), qr_token (UNIQUE, the only value placed inside the QR code),
  order_id, event_id, ticket_type_id, attendee_name/email/phone, status (valid|void|used), checked_in,
  checked_in_at, checked_in_by` (check-in state lives here; there is no separate check-ins table)
- `event_staff` - assigns `event_staff` users to specific events (checked by the Worker at check-in)
- `contact_messages` - messages from `contact/index.html`; each submission is also
  emailed (`contact_message`) to the platform support address and to every active
  platform owner, with an acknowledgement (`contact_ack`) sent back to the sender
- `email_outbox` - queued transactional email for the Worker to dispatch (subject, HTML + text body,
  `template`, `status` `queued|sent|failed`, `attempts`, `error`, provider message id). Every
  template is written here first, so a Brevo outage never loses a ticket email - the queue is
  flushed inline after each event, from *Owner → Settings → Transactional email* (**Flush queue
  now**), and by the optional Cron Trigger (`worker/index.js` `scheduled`). See
  [`worker/emails.js`](worker/emails.js).
- `app_settings` - platform-level flags and limits read by the Worker

Money is always stored as an integer number of Kenyan Shillings (`1500` = `KSh 1,500`). No floating
point arithmetic is used for money in the frontend or the schema.

---

## 8. Security checklist

- [x] No Paystack/Paystack webhook secret, Firebase Admin credential, R2 key or Cloudflare token in any HTML file
- [x] Amounts, availability and sales windows validated server side (`POST /api/orders` recalculates)
- [x] Payment status read from the Worker, never from the return URL
- [x] Ticket validity decided by `POST /api/check-in`; the scanner page only displays the answer
- [x] Ticket QR images generated by the Worker and containing a random token only
- [x] Organizer pages send Firebase ID tokens; the Worker enforces ownership and roles
- [x] Event staff are restricted to assigned events (`event_staff` table, checked by the Worker)
- [x] Turnstile mounted on organizer registration, the single sign-in page, password reset, event creation, checkout and the contact form (single-use token `turnstile_token`, verified server-side with hostname + action checks)
- [x] `login/` and `forgot-password/` verify the challenge at `POST /api/auth/turnstile` before any Firebase call
- [x] Payment webhooks and IPN callbacks stay reachable without a browser token
- [x] Every abuse-prone endpoint is rate limited **in the Worker** (memory → optional native binding → D1), keyed by Firebase UID, Cloudflare client IP, hashed email and/or order reference, layered so no single identity is trusted
- [x] Rate-limit counters are bucketed per window and swept when they expire; `rate_key` is a SHA-256 hash, so no IP, UID or address is stored
- [x] Over-limit requests get `429` + `Retry-After` with a message that never reveals which limit was hit
- [x] Parameterised D1 queries are a Worker responsibility; the frontend never builds SQL
- [x] `localStorage`/`sessionStorage` hold UI preferences and the checkout draft only - no secrets, no tokens
- [x] No inline `onclick` handlers anywhere; all behaviour uses `addEventListener`
- [x] Every static response carries a strict `Content-Security-Policy` plus HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` and cross-origin isolation headers (`_headers`, applied by Cloudflare Pages)
- [x] The deployed site never hands out the backend: `/worker/*`, `/tools/*` and the dev/test harnesses (several of which embed or import the whole Worker source) are proxied to the homepage by `_redirects`, so `worker/index.js`, the schema and the check pages are not publicly readable
- [x] Payment callback bodies are only ever trusted after the provider's own verification; the amount is compared with the stored order total and the reference with the one this server issued

---

## 9. Accessibility, SEO and responsiveness

- Semantic landmarks (`header`, `nav`, `main`, `section`, `footer`), labelled form controls, visible focus
  rings, `aria-live` regions for loading/empty/error states and large tap targets (44 px minimum).
- `event/index.html` rewrites the document title, meta description, canonical link and Open Graph tags from the
  event payload, for example `Nairobi Business Summit Tickets | Prince Alex TicketHub`.
- Posters always carry descriptive `alt` text and fall back to a branded placeholder tile if an image fails.
- The home hero is `hero.png` used as a full-bleed background behind the headline; it stays a real `<img>` with
  `alt` text and `fetchpriority="high"` rather than a CSS `background-image`, so the description and early fetch
  are preserved. A dark scrim keeps the headline and search bar readable on any crop.
- Mobile first: compact navigation with a hamburger menu, stacked cards, horizontally scrollable filters
  and a simple single-column checkout.

---

## 10. Running and deploying the frontend

No build step. Any static host works.

```powershell
# Local preview (choose one)
python -m http.server 5173            # http://localhost:5173
npx serve .                           # if Node is available
```

> The camera in `check-in/index.html` requires a secure context (HTTPS or `localhost`) and browser
> permission. The preview opens independently of QR decoding; QR scanning uses the browser
> `BarcodeDetector` API. Where it is unavailable the page explains this and offers manual ticket
> lookup, so no external library is required.

Recommended production setup:

1. Deploy these files with Cloudflare Pages (`index.html` as the root document) — the production
   site is `https://tickethub.princealex.digital`. Deploy the folder **as-is**: the `_redirects`
   and `_headers` files at the root are what keep the backend source, the dev harnesses and the
   security headers (CSP, HSTS, framing, etc.) applied — see [`SECURITY.md`](SECURITY.md).
2. In the Worker, set the plain-text vars `ALLOWED_ORIGINS` (comma-separated) and `FRONTEND_URL`
   to `https://tickethub.princealex.digital`, so the browser is allowed to call the API — see
   `worker/README.md` §1.4. The site origin and all email/payment links fall back to this domain
   even if the vars are missing. The `Authorization` header is already allowed. Ports `8000` and
   `5500` are built in for local work, so add your preview origin (e.g. `http://localhost:5173`
   from §10 above, or `http://127.0.0.1:5173`) to `ALLOWED_ORIGINS` if you serve on another port.
3. Apply `worker/schema.sql` to D1 (`wrangler d1 execute <db> --file worker/schema.sql`).
4. Create the Firebase project, enable Email/Password, and put the web config in `firebase.js` (single source, shared by all pages).
   Add `tickethub.princealex.digital` (and `localhost`) to Firebase Authentication → Settings →
   **Authorized domains**, so the password-reset email can link back to `/login/`.
5. Set the Paystack webhook URL to `https://<worker-domain>/api/webhooks/paystack` and the Pesapal IPN URL to `https://<worker-domain>/api/webhooks/pesapal`.
6. Create a Cloudflare Turnstile widget (Managed widget mode) and paste its **site key** into the protected pages. The **secret key** goes into the Worker only, as the `TURNSTILE_SECRET` secret (`wrangler secret put TURNSTILE_SECRET`).
7. **Run the rate-limit migration** — without it the Worker can only count per isolate:
   `wrangler d1 execute princealextickethub --file=worker/migrations/0001_rate_limits.sql`
   (already part of `worker/schema.sql` for fresh databases). Confirm with
   `GET /api/health` → `rate_limit_store: "d1"`.
8. Optional but recommended: add Cloudflare WAF / rate-limiting rules for broad
   traffic shaping (e.g. 300 req/min per IP on `*/api/*`, and a stricter rule on
   `/api/check-in`), and bind the native `RATE_LIMITER` binding from
   `worker/wrangler.toml` on a Workers Paid plan. Application limits stay in
   `RATE_POLICIES` regardless.

---

## 11. Known limitations (by design)

- The Worker, D1 database, R2 bucket, Firebase project and Paystack account are not part of this
  repository; the frontend expects them to exist and reports honestly when they do not.
- Nothing is faked: with placeholder configuration the pages show neutral "not connected yet" states
  instead of invented events, orders or successful payments.
- Floating point money is never used; the Worker must keep prices as integer KES and the frontend
  renders them with `KSh` formatting.

---

**Prince Alex TicketHub** - Powered by Prince Alex Digital
