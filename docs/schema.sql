-- ============================================================================
-- Prince Alex TicketHub - Cloudflare D1 schema (worker/schema.sql)
-- Powered by Prince Alex Digital
-- ----------------------------------------------------------------------------
-- Money is stored as INTEGER KES major units: 1500 = KSh 1,500.
-- (Paystack expects a subunit amount and is multiplied by 100 at the provider
--  boundary only - the database always holds whole shillings. Pesapal and
--  PayHero are called in whole KES, exactly like the stored value.)
--
-- Credentials (Paystack secret key, Pesapal consumer secret, PayHero API
-- password) are NEVER stored in plaintext: they are AES-GCM encrypted with the
-- PAYMENT_ENCRYPTION_KEY Worker secret and only the ciphertext lives here.
-- Three providers are supported behind one common transaction model:
-- paystack | pesapal | payhero.
--
-- Bootstrap the platform owner AFTER that person signs up in Firebase:
--   UPDATE users SET firebase_uid='<firebase-uid>' WHERE email='owner@example.com';
-- or insert the row with firebase_uid NULL and let the first sign-in attach it.
-- Nothing in the Worker ever creates an owner automatically.
--
-- Apply (local)  : wrangler d1 execute TICKETHUB_DB --file worker/schema.sql
-- Apply (remote) : wrangler d1 execute TICKETHUB_DB --file worker/schema.sql --remote
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------------ users ----
-- firebase_uid is nullable so an owner / staff row can be pre-seeded by email
-- before that person ever signs in. The Worker attaches the uid on first login.
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    firebase_uid  TEXT UNIQUE,
    full_name     TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    phone         TEXT,
    role          TEXT NOT NULL DEFAULT 'organizer'
                  CHECK (role IN ('owner','organizer','event_staff')),
    status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','suspended','deleted')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------- organizers ----
CREATE TABLE IF NOT EXISTS organizers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL UNIQUE,
    business_name   TEXT,
    business_email  TEXT,
    business_phone  TEXT,
    logo_url        TEXT,
    logo_key        TEXT,
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended')),
    -- Account-wide default for "owner payment mode": when 1, events that do not
    -- set their own payment_mode collect through the platform owner's account.
    use_owner_payments INTEGER NOT NULL DEFAULT 0 CHECK (use_owner_payments IN (0,1)),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- events -----
-- Statuses: draft | pending | active | paused | ended | cancelled
CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    organizer_id INTEGER NOT NULL,
    title        TEXT NOT NULL,
    slug         TEXT NOT NULL UNIQUE,
    description  TEXT,
    category     TEXT,
    venue        TEXT,
    location     TEXT,
    event_date   TEXT NOT NULL,
    start_time   TEXT,
    end_time     TEXT,
    poster_url   TEXT,
    poster_key   TEXT,
    status       TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','pending','active','paused','ended','cancelled')),
    is_featured  INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0,1)),
    sales_start  TEXT,
    sales_end    TEXT,
    -- Optional per-event override. NULL = use the organizer's active provider.
    payment_provider TEXT
                 CHECK (payment_provider IS NULL OR payment_provider IN ('paystack','pesapal','payhero')),
    -- Who collects the money for this event.
    --   NULL  = inherit the organizer's account default (organizers.use_owner_payments)
    --   'own' = the organizer's own connected merchant account
    --   'owner' = the platform owner's account (owner payment mode)
    payment_mode TEXT
                 CHECK (payment_mode IS NULL OR payment_mode IN ('own','owner')),
    -- Free-ticket verification (migration 0006). Safe defaults keep every
    -- pre-existing event working: OTP on, one free ticket per verified email,
    -- IP abuse-prevention on, no per-event threshold overrides.
    free_otp_enabled   INTEGER NOT NULL DEFAULT 1 CHECK (free_otp_enabled IN (0,1)),
    free_ticket_limit  INTEGER NOT NULL DEFAULT 1 CHECK (free_ticket_limit >= 1),
    ip_abuse_enabled   INTEGER NOT NULL DEFAULT 1 CHECK (ip_abuse_enabled IN (0,1)),
    free_ticket_config TEXT,     -- optional JSON of per-event rate thresholds (clamped in the Worker)
    -- Which organizer agreement version governed this event when it was published
    -- (migration 0008). NULL = published before the agreement system existed, or
    -- never published. Stamped by the Worker on every successful publication.
    agreement_id       INTEGER,
    agreement_version  TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (organizer_id) REFERENCES organizers(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------- ticket_types -----
CREATE TABLE IF NOT EXISTS ticket_types (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    INTEGER NOT NULL,
    name        TEXT NOT NULL,
    description TEXT,
    price       INTEGER NOT NULL CHECK (price >= 0),
    quantity    INTEGER NOT NULL CHECK (quantity >= 0),
    sold        INTEGER NOT NULL DEFAULT 0 CHECK (sold >= 0),
    sales_start TEXT,
    sales_end   TEXT,
    status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','paused','hidden')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

-- ----------------------------------------------------- payment_settings ------
-- One row per organizer: which provider is ACTIVE (provider) plus the legacy
-- credential columns kept for backward compatibility. New configuration writes
-- per provider into organizer_payment_providers below; this row stays the single
-- source of truth for "which provider does checkout use".
-- secret_key_encrypted / consumer_secret_encrypted hold AES-GCM ciphertext
-- (v1.<iv>.<ct>) and are NEVER returned by any endpoint.
CREATE TABLE IF NOT EXISTS payment_settings (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    organizer_id              INTEGER NOT NULL UNIQUE,
    provider                  TEXT NOT NULL DEFAULT 'paystack'
                              CHECK (provider IN ('paystack','pesapal','payhero')),
    public_key                TEXT,
    secret_key_encrypted      TEXT,
    consumer_key              TEXT,
    consumer_secret_encrypted TEXT,
    ipn_id                    TEXT,
    status                    TEXT NOT NULL DEFAULT 'not_connected'
                              CHECK (status IN ('not_connected','connected','configuration_required','error')),
    last_tested_at            TEXT,
    last_error                TEXT,
    created_at                TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (organizer_id) REFERENCES organizers(id) ON DELETE CASCADE
);

-- ------------------------------------------- organizer_payment_providers ------
-- One row per organizer AND provider, so Paystack, Pesapal and PayHero can all
-- be connected at the same time and the organizer can switch the active one at
-- any moment. Only non-secret identifiers are readable back by their owner;
-- every secret column is AES-GCM ciphertext and never leaves the Worker.
CREATE TABLE IF NOT EXISTS organizer_payment_providers (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    organizer_id              INTEGER NOT NULL,
    provider                  TEXT NOT NULL CHECK (provider IN ('paystack','pesapal','payhero')),
    status                    TEXT NOT NULL DEFAULT 'not_connected'
                              CHECK (status IN ('not_connected','connected','configuration_required','error')),
    enabled                   INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
    public_key                TEXT,     -- paystack  pk_live_...
    consumer_key              TEXT,     -- pesapal   consumer key
    ipn_id                    TEXT,     -- pesapal   registered IPN id
    api_username              TEXT,     -- payhero   API username
    channel_id                TEXT,     -- payhero   payment channel id
    secret_key_encrypted      TEXT,     -- paystack  secret key
    consumer_secret_encrypted TEXT,     -- pesapal   consumer secret
    password_encrypted        TEXT,     -- payhero   API password / auth token
    last_tested_at            TEXT,
    last_error                TEXT,
    connected_at              TEXT,
    created_at                TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (organizer_id, provider),
    FOREIGN KEY (organizer_id) REFERENCES organizers(id) ON DELETE CASCADE
);

-- -------------------------------------------- platform_payment_providers ------
-- The platform OWNER's own merchant accounts, one row per provider. Same columns
-- as organizer_payment_providers minus organizer_id (there is exactly one owner).
-- Any organizer whose event is in "owner payment mode" is sold through the
-- owner's active account here. Secrets are AES-GCM ciphertext, exactly like the
-- organizer store, and never leave the Worker.
CREATE TABLE IF NOT EXISTS platform_payment_providers (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    provider                  TEXT NOT NULL UNIQUE CHECK (provider IN ('paystack','pesapal','payhero')),
    status                    TEXT NOT NULL DEFAULT 'not_connected'
                              CHECK (status IN ('not_connected','connected','configuration_required','error')),
    enabled                   INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
    public_key                TEXT,     -- paystack  pk_live_...
    consumer_key              TEXT,     -- pesapal   consumer key
    ipn_id                    TEXT,     -- pesapal   registered IPN id
    api_username              TEXT,     -- payhero   API username
    channel_id                TEXT,     -- payhero   payment channel id
    secret_key_encrypted      TEXT,     -- paystack  secret key
    consumer_secret_encrypted TEXT,     -- pesapal   consumer secret
    password_encrypted        TEXT,     -- payhero   API password / auth token
    last_tested_at            TEXT,
    last_error                TEXT,
    connected_at              TEXT,
    created_at                TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------- orders -----
-- Statuses: pending | paid | failed | cancelled | refunded
-- total_amount is always recalculated by the Worker from ticket_types.price.
-- inventory_held marks that this order's quantities are currently reserved in
-- ticket_types.sold, so releasing/cancelling it can never double-decrement.
CREATE TABLE IF NOT EXISTS orders (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number   TEXT NOT NULL UNIQUE,
    event_id       INTEGER NOT NULL,
    organizer_id   INTEGER NOT NULL,
    customer_name  TEXT NOT NULL,
    customer_email TEXT,
    customer_phone TEXT NOT NULL,
    total_amount   INTEGER NOT NULL CHECK (total_amount >= 0),
    currency       TEXT NOT NULL DEFAULT 'KES',
    status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','paid','failed','cancelled','refunded')),
    inventory_held INTEGER NOT NULL DEFAULT 1 CHECK (inventory_held IN (0,1)),
    paid_at        TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY (organizer_id) REFERENCES organizers(id) ON DELETE CASCADE
);

-- ------------------------------------------------------------ order_items ----
-- unit_price is the price captured at purchase time, so later organizer price
-- edits cannot rewrite the history of a paid order.
CREATE TABLE IF NOT EXISTS order_items (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id       INTEGER NOT NULL,
    ticket_type_id INTEGER NOT NULL,
    ticket_type_name TEXT,
    quantity       INTEGER NOT NULL CHECK (quantity > 0),
    unit_price     INTEGER NOT NULL CHECK (unit_price >= 0),
    subtotal       INTEGER NOT NULL CHECK (subtotal >= 0),
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (ticket_type_id) REFERENCES ticket_types(id)
);

-- -------------------------------------------------------------- payments -----
-- One common payment transaction model for all three providers. The `provider`
-- column is the only thing that changes between them; everything provider
-- specific is carried in provider_ref / provider_metadata / provider_response.
-- statuses: pending | success | failed | abandoned | reversed
-- reference is unique: the same provider reference can never be applied twice,
-- which is what makes webhook/IPN replay harmless.
CREATE TABLE IF NOT EXISTS payments (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id          INTEGER NOT NULL,
    provider          TEXT NOT NULL CHECK (provider IN ('paystack','pesapal','payhero')),
    reference         TEXT NOT NULL UNIQUE,
    provider_ref      TEXT,                -- Paystack tx id / Pesapal OrderTrackingId / PayHero reference
    amount            INTEGER NOT NULL CHECK (amount >= 0),
    currency          TEXT NOT NULL DEFAULT 'KES',
    status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','success','failed','abandoned','reversed')),
    failure_reason    TEXT,                -- 'amount_mismatch' | 'currency_mismatch' | 'failed' | 'abandoned' | ...
    failure_at        TEXT,
    provider_metadata TEXT,                -- provider-specific JSON (channel id, M-Pesa receipt, checkout request ...)
    paid_at           TEXT,
    provider_response TEXT,                -- sanitised JSON snapshot of last verification
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

-- --------------------------------------------------------------- tickets -----
-- qr_token is the ONLY thing placed inside a QR code: a random opaque token.
-- No names, phones or emails are ever encoded into the QR image.
CREATE TABLE IF NOT EXISTS tickets (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id         INTEGER NOT NULL,
    event_id         INTEGER NOT NULL,
    ticket_type_id   INTEGER NOT NULL,
    attendee_name    TEXT NOT NULL,
    attendee_email   TEXT,
    attendee_phone   TEXT,
    ticket_number    TEXT NOT NULL UNIQUE,
    qr_token         TEXT NOT NULL UNIQUE,
    status           TEXT NOT NULL DEFAULT 'valid'
                     CHECK (status IN ('valid','void','used')),
    checked_in       INTEGER NOT NULL DEFAULT 0 CHECK (checked_in IN (0,1)),
    checked_in_at    TEXT,
    checked_in_by    INTEGER,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY (ticket_type_id) REFERENCES ticket_types(id)
);

-- ----------------------------------------------------------- event_staff -----
-- Maps a D1 user (role = 'event_staff') to the events they may check in.
CREATE TABLE IF NOT EXISTS event_staff (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    event_id   INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, event_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

-- ------------------------------------------------------- contact messages ----
CREATE TABLE IF NOT EXISTS contact_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL,
    subject    TEXT,
    message    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ----------------------------------------------------------- email outbox ----
-- Real delivery needs a mail provider; until one is configured the Worker
-- records every outbound mail here so nothing is silently dropped.
CREATE TABLE IF NOT EXISTS email_outbox (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    to_email     TEXT NOT NULL,
    subject      TEXT NOT NULL,
    template     TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','sent','failed')),
    error        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at      TEXT
);

-- -------------------------------------------------------- platform settings --
-- Owner-managed platform settings (public support address, provider defaults).
CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------ organizer agreement system (0008) -----
-- The mandatory Digital Organizer Agreement & platform fee terms. A version is
-- created as a draft, reviewed, then activated; activating a version supersedes
-- the previous one. Once a version has been accepted by an organizer its text
-- and fee configuration are immutable - commercial changes require a NEW
-- version. See worker/migrations/0008_organizer_agreements.sql for the
-- migration that adds these tables to an existing database.
CREATE TABLE IF NOT EXISTS platform_agreements (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    version         TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    content         TEXT NOT NULL,
    summary         TEXT,
    fee_config_json TEXT NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','active','superseded','archived')),
    effective_date  TEXT,
    content_hash    TEXT,
    created_by      INTEGER,
    activated_by    INTEGER,
    activated_at    TEXT,
    archived_at     TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (created_by)   REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (activated_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS agreement_invitations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash   TEXT NOT NULL UNIQUE,
    organizer_id INTEGER NOT NULL,
    user_id      INTEGER,
    agreement_id INTEGER NOT NULL,
    email        TEXT,
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','used','expired','revoked')),
    issued_by    INTEGER,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at   TEXT NOT NULL,
    used_at      TEXT,
    FOREIGN KEY (organizer_id) REFERENCES organizers(id) ON DELETE CASCADE,
    FOREIGN KEY (agreement_id) REFERENCES platform_agreements(id),
    FOREIGN KEY (user_id)      REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (issued_by)    REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS organizer_agreements (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    organizer_id              INTEGER NOT NULL,
    user_id                   INTEGER,
    agreement_id              INTEGER NOT NULL,
    agreement_version         TEXT NOT NULL,
    signatory_name            TEXT NOT NULL,
    signatory_email           TEXT NOT NULL,
    signatory_role            TEXT,
    status                    TEXT NOT NULL DEFAULT 'accepted'
                              CHECK (status IN ('accepted','revoked')),
    accepted_at               TEXT NOT NULL,
    content_snapshot          TEXT NOT NULL,
    fee_snapshot_json         TEXT NOT NULL DEFAULT '{}',
    reference                 TEXT NOT NULL UNIQUE,
    verification_method       TEXT NOT NULL DEFAULT 'firebase_authenticated_email_and_single_use_token',
    evidence_json             TEXT,
    invitation_id             INTEGER,
    document_key              TEXT,
    document_sha256           TEXT,
    confirmation_email_status TEXT,
    revoked_at                TEXT,
    revoked_by                INTEGER,
    revoke_reason             TEXT,
    created_at                TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (organizer_id, agreement_id),
    FOREIGN KEY (organizer_id)  REFERENCES organizers(id) ON DELETE CASCADE,
    FOREIGN KEY (agreement_id)  REFERENCES platform_agreements(id),
    FOREIGN KEY (invitation_id) REFERENCES agreement_invitations(id),
    FOREIGN KEY (user_id)       REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (revoked_by)    REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS agreement_audit_log (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    action            TEXT NOT NULL,
    agreement_id      INTEGER,
    agreement_version TEXT,
    organizer_id      INTEGER,
    actor_user_id     INTEGER,
    actor_role        TEXT,
    subject_user_id   INTEGER,
    detail_json       TEXT,
    ip_hash           TEXT,
    user_agent        TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ----------------------------------------------------------------- indexes ---
CREATE INDEX IF NOT EXISTS idx_users_firebase_uid    ON users(firebase_uid);
CREATE INDEX IF NOT EXISTS idx_users_email           ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role            ON users(role);
CREATE INDEX IF NOT EXISTS idx_organizers_user       ON organizers(user_id);
CREATE INDEX IF NOT EXISTS idx_organizers_status     ON organizers(status);
CREATE INDEX IF NOT EXISTS idx_events_slug           ON events(slug);
CREATE INDEX IF NOT EXISTS idx_events_organizer      ON events(organizer_id);
CREATE INDEX IF NOT EXISTS idx_events_status         ON events(status);
CREATE INDEX IF NOT EXISTS idx_events_category       ON events(category);
CREATE INDEX IF NOT EXISTS idx_events_date           ON events(event_date);
CREATE INDEX IF NOT EXISTS idx_events_featured       ON events(is_featured);
CREATE INDEX IF NOT EXISTS idx_ticket_types_event    ON ticket_types(event_id);
CREATE INDEX IF NOT EXISTS idx_ticket_types_status   ON ticket_types(status);
CREATE INDEX IF NOT EXISTS idx_orders_number         ON orders(order_number);
CREATE INDEX IF NOT EXISTS idx_orders_event          ON orders(event_id);
CREATE INDEX IF NOT EXISTS idx_orders_organizer      ON orders(organizer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status         ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created        ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_order_items_order     ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_type      ON order_items(ticket_type_id);
CREATE INDEX IF NOT EXISTS idx_payments_reference    ON payments(reference);
CREATE INDEX IF NOT EXISTS idx_payments_provider_ref ON payments(provider_ref);
CREATE INDEX IF NOT EXISTS idx_payments_order        ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status       ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_provider     ON payments(provider);
CREATE INDEX IF NOT EXISTS idx_tickets_number        ON tickets(ticket_number);
CREATE INDEX IF NOT EXISTS idx_tickets_qr_token      ON tickets(qr_token);
CREATE INDEX IF NOT EXISTS idx_tickets_event         ON tickets(event_id);
CREATE INDEX IF NOT EXISTS idx_tickets_order         ON tickets(order_id);
CREATE INDEX IF NOT EXISTS idx_tickets_checked_in    ON tickets(checked_in);
CREATE INDEX IF NOT EXISTS idx_event_staff_user      ON event_staff(user_id);
CREATE INDEX IF NOT EXISTS idx_event_staff_event     ON event_staff(event_id);
CREATE INDEX IF NOT EXISTS idx_payment_settings_org  ON payment_settings(organizer_id);
CREATE INDEX IF NOT EXISTS idx_opp_organizer         ON organizer_payment_providers(organizer_id);
CREATE INDEX IF NOT EXISTS idx_opp_provider          ON organizer_payment_providers(provider);
CREATE INDEX IF NOT EXISTS idx_platform_pp_provider  ON platform_payment_providers(provider);
CREATE INDEX IF NOT EXISTS idx_email_outbox_status   ON email_outbox(status);
/* Organizer agreement system (0008) */
CREATE INDEX IF NOT EXISTS idx_platform_agreements_status  ON platform_agreements(status);
CREATE INDEX IF NOT EXISTS idx_platform_agreements_version ON platform_agreements(version);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_agreements_one_active
    ON platform_agreements(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_agreement_invitations_org       ON agreement_invitations(organizer_id, agreement_id, status);
CREATE INDEX IF NOT EXISTS idx_agreement_invitations_agreement ON agreement_invitations(agreement_id);
CREATE INDEX IF NOT EXISTS idx_agreement_invitations_expires   ON agreement_invitations(expires_at);
CREATE INDEX IF NOT EXISTS idx_organizer_agreements_org        ON organizer_agreements(organizer_id, status);
CREATE INDEX IF NOT EXISTS idx_organizer_agreements_agreement  ON organizer_agreements(agreement_id, status);
CREATE INDEX IF NOT EXISTS idx_organizer_agreements_reference  ON organizer_agreements(reference);
CREATE INDEX IF NOT EXISTS idx_agreement_audit_agreement       ON agreement_audit_log(agreement_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agreement_audit_org             ON agreement_audit_log(organizer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agreement_audit_action          ON agreement_audit_log(action, created_at);

-- ------------------------------------------------------------- rate limits ----
-- One row per identity per fixed window, for the Worker's server-side rate
-- limiting (see RATE_POLICIES in index.js). rate_key is
-- sha256(identity|window_start) - no IP, UID or email address is ever stored.
-- Rows are removed once their window has expired: the Worker sweeps them on a
-- timer and on every cron tick, so the table only ever holds live windows.
CREATE TABLE IF NOT EXISTS rate_limits (
    rate_key      TEXT PRIMARY KEY,     -- sha256(identity|window_start)
    action        TEXT NOT NULL,        -- policy name, e.g. "login", "checkout"
    window_start  INTEGER NOT NULL,     -- epoch ms, floored to the window
    request_count INTEGER NOT NULL DEFAULT 0,
    expires_at    INTEGER NOT NULL,     -- epoch ms when the window ends
    updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits(expires_at);
CREATE INDEX IF NOT EXISTS idx_rate_limits_action  ON rate_limits(action);

-- ------------------------------------------- free ticket verification --------
-- Email OTP sessions for FREE ticket claims (migration 0006). The six digits are
-- never stored: otp_hash is a keyed HMAC. IP addresses are never stored: ip_hash
-- is an HMAC. See worker/migrations/0006_free_ticket_otp.sql.
CREATE TABLE IF NOT EXISTS free_ticket_sessions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    session_token       TEXT NOT NULL UNIQUE,
    continue_hash       TEXT,
    event_id            INTEGER NOT NULL,
    email               TEXT NOT NULL,
    email_hash          TEXT NOT NULL,
    name                TEXT,
    quantity            INTEGER NOT NULL DEFAULT 1,
    ticket_type_id      INTEGER,
    otp_hash            TEXT NOT NULL,
    attempts            INTEGER NOT NULL DEFAULT 0,
    resends             INTEGER NOT NULL DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','verified','consumed','expired','superseded')),
    ip_hash             TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at          TEXT NOT NULL,
    last_sent_at        TEXT,
    verified_at         TEXT,
    continue_expires_at TEXT,
    consumed_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_fts_continue     ON free_ticket_sessions(continue_hash);
CREATE INDEX IF NOT EXISTS idx_fts_event_email  ON free_ticket_sessions(event_id, email_hash, status);
CREATE INDEX IF NOT EXISTS idx_fts_status_exp   ON free_ticket_sessions(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_fts_event_status ON free_ticket_sessions(event_id, status);

-- One row per free ticket slot. The PARTIAL UNIQUE index is the concurrency
-- guard that makes the per-email free-ticket limit un-bypassable under races.
CREATE TABLE IF NOT EXISTS free_ticket_claims (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    INTEGER NOT NULL,
    email_hash  TEXT NOT NULL,
    slot        INTEGER NOT NULL,
    order_id    INTEGER,
    session_id  INTEGER,
    quantity    INTEGER NOT NULL DEFAULT 1,
    status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','released')),
    ip_hash     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ftc_active_slot ON free_ticket_claims(event_id, email_hash, slot) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_ftc_lookup   ON free_ticket_claims(event_id, email_hash, status);
CREATE INDEX IF NOT EXISTS idx_ftc_order    ON free_ticket_claims(order_id);
CREATE INDEX IF NOT EXISTS idx_ftc_created  ON free_ticket_claims(created_at);

-- ------------------------------------------------------------------- seed ----
-- Platform owner. Create the account in Firebase Authentication first, then
-- attach its uid here (or leave firebase_uid NULL and the first sign-in with
-- this email attaches it). Never insert an owner from application code.
-- INSERT INTO users (firebase_uid, full_name, email, role, status)
-- VALUES (NULL, 'Prince Alex', 'owner@princealexdigital.com', 'owner', 'active');
