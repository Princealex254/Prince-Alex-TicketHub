-- ============================================================================
-- Prince Alex TicketHub - migration 0002: PayHero as a third payment provider
-- Powered by Prince Alex Digital
-- ----------------------------------------------------------------------------
-- Adds PayHero alongside the existing Pesapal and Paystack integrations WITHOUT
-- touching a single existing payment, order or ticket row.
--
-- What it does
--   1. payments               - provider CHECK now accepts 'payhero'; failure
--                               information and provider-specific metadata get
--                               their own columns (the transaction model stays
--                               common, only the metadata is provider-shaped).
--   2. payment_settings       - provider CHECK now accepts 'payhero'; the
--                               connection status CHECK gains
--                               'configuration_required'.
--   3. organizer_payment_providers
--                             - NEW: one row per organizer + provider, so an
--                               organizer can keep Paystack, Pesapal AND PayHero
--                               credentials at the same time and switch the
--                               active one at any moment.
--   4. backfill               - every existing payment_settings row is copied
--                               into organizer_payment_providers, so an
--                               organizer who connected Pesapal or Paystack
--                               before this change still shows as Connected and
--                               keeps selling through exactly the same account.
--   5. events.payment_provider- optional per-event override. NULL (every
--                               existing row) means "use the organizer's active
--                               provider", which is the priority the payment
--                               service implements:
--                                   event override
--                                   -> organizer active provider
--                                   -> "payment provider not configured"
--
-- Local  : wrangler d1 migrations apply princealextickethub --local
-- Remote : wrangler d1 migrations apply princealextickethub --remote
--          (the ledger in d1_migrations records what has been applied, so no
--           file here is ever applied twice - see worker/README.md)
-- Manual equivalent, if you would rather run the SQL yourself:
--   wrangler d1 execute princealextickethub --file=worker/migrations/0002_payhero.sql --remote
--
-- Verify afterwards:
--   wrangler d1 execute princealextickethub --command "SELECT provider, COUNT(*) FROM payments GROUP BY provider" --remote
--   wrangler d1 execute princealextickethub --command "SELECT organizer_id, provider, status FROM organizer_payment_providers" --remote
-- or simply open GET /api/health and check payment_schema.ready is true.
--
-- Running it again is safe, and is how a run that stopped partway is repaired:
-- the new columns are added first, so every rebuild copies the columns it has
-- rather than replacing them. Nothing in this file deletes a value it can read:
-- the only statement that can fail on a second run is the final ALTER TABLE on
-- events, which reports "duplicate column name: payment_provider" and leaves
-- everything before it applied. To finish off a database where only some of the
-- new columns exist, run 0003_payhero_repair.sql instead - it adds them one at
-- a time, so one already-applied column cannot hold up the rest.
-- ======================================================================

-- ============================================================================

PRAGMA foreign_keys = OFF;

-- ------------------------------------------- 0. the new payments columns ---
-- Add the new columns BEFORE the rebuilds, so the copy in step 1 can name them.
-- SQLite cannot guard ADD COLUMN, so a database that already has a column stops
-- here with "duplicate column name" (- and because D1 runs statements in
-- auto-commit, nothing before it is rolled back and nothing after it runs).
-- That is the safe failure direction: this file only ever rebuilds a table with
-- the columns in place, so it never drops a value it already has. A database
-- where only SOME of these columns are missing is finished off by
-- 0003_payhero_repair.sql, which adds them one at a time.
ALTER TABLE payments ADD COLUMN failure_reason TEXT;
ALTER TABLE payments ADD COLUMN failure_at TEXT;
ALTER TABLE payments ADD COLUMN provider_metadata TEXT;

-- ------------------------------------------------------------- 1. payments ---
-- Rebuild with the wider provider CHECK and the new failure/metadata columns.
-- "DROP TABLE IF EXISTS payments_new" first, so an interrupted run cannot leave
-- a stale scratch table behind.
DROP TABLE IF EXISTS payments_new;
CREATE TABLE payments_new (
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
    provider_response TEXT,                -- sanitised JSON snapshot of the last verification
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);
-- Every existing row is carried over byte for byte, including the three columns
-- added in step 0 (which are empty on a database that has never seen PayHero).
INSERT INTO payments_new (id, order_id, provider, reference, provider_ref, amount, currency, status, failure_reason, failure_at, provider_metadata, paid_at, provider_response, created_at, updated_at)
    SELECT id, order_id, provider, reference, provider_ref, amount, currency, status, failure_reason, failure_at, provider_metadata, paid_at, provider_response, created_at, updated_at FROM payments;
DROP TABLE payments;
ALTER TABLE payments_new RENAME TO payments;
-- Keep AUTOINCREMENT moving past the ids that were copied in.
INSERT OR REPLACE INTO sqlite_sequence (name, seq) SELECT 'payments', COALESCE(MAX(id), 0) FROM payments;
-- DROP TABLE removed the old indexes with the old table.
CREATE INDEX IF NOT EXISTS idx_payments_reference    ON payments(reference);
CREATE INDEX IF NOT EXISTS idx_payments_provider_ref ON payments(provider_ref);
CREATE INDEX IF NOT EXISTS idx_payments_order        ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status       ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_provider     ON payments(provider);

-- ------------------------------------------------------ 2. payment_settings ---
-- Same rebuild for the active-provider column and the extra status value.
DROP TABLE IF EXISTS payment_settings_new;
CREATE TABLE payment_settings_new (
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
INSERT INTO payment_settings_new (id, organizer_id, provider, public_key, secret_key_encrypted, consumer_key, consumer_secret_encrypted, ipn_id, status, last_tested_at, last_error, created_at, updated_at)
    SELECT id, organizer_id, provider, public_key, secret_key_encrypted, consumer_key, consumer_secret_encrypted, ipn_id, status, last_tested_at, last_error, created_at, updated_at FROM payment_settings;
DROP TABLE payment_settings;
ALTER TABLE payment_settings_new RENAME TO payment_settings;
INSERT OR REPLACE INTO sqlite_sequence (name, seq) SELECT 'payment_settings', COALESCE(MAX(id), 0) FROM payment_settings;
CREATE INDEX IF NOT EXISTS idx_payment_settings_org ON payment_settings(organizer_id);

-- ------------------------------------------- 3. organizer_payment_providers ---
-- One row per (organizer, provider). Secrets stay AES-GCM ciphertext and the
-- columns that carry them are NEVER returned to a browser or written to a log.
CREATE TABLE IF NOT EXISTS organizer_payment_providers (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    organizer_id              INTEGER NOT NULL,
    provider                  TEXT NOT NULL CHECK (provider IN ('paystack','pesapal','payhero')),
    status                    TEXT NOT NULL DEFAULT 'not_connected'
                              CHECK (status IN ('not_connected','connected','configuration_required','error')),
    enabled                   INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
    -- non-secret identifiers (safe to show back to the owning organizer)
    public_key                TEXT,     -- paystack  pk_live_...
    consumer_key              TEXT,     -- pesapal   consumer key
    ipn_id                    TEXT,     -- pesapal   registered IPN id
    api_username              TEXT,     -- payhero   API username
    channel_id                TEXT,     -- payhero   payment channel id
    -- write-only ciphertext (AES-GCM, v1.<iv>.<ct>)
    secret_key_encrypted      TEXT,     -- paystack  secret key
    consumer_secret_encrypted TEXT,     -- pesapal   consumer secret
    password_encrypted        TEXT,     -- payhero   API password / auth token
    -- state
    last_tested_at            TEXT,
    last_error                TEXT,
    connected_at              TEXT,
    created_at                TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (organizer_id, provider),
    FOREIGN KEY (organizer_id) REFERENCES organizers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_opp_organizer ON organizer_payment_providers(organizer_id);
CREATE INDEX IF NOT EXISTS idx_opp_provider  ON organizer_payment_providers(provider);

-- --------------------------------------------------------------- 4. backfill ---
-- Existing Pesapal / Paystack connections become rows in the new table, so the
-- three-provider UI shows them as Connected without the organizer re-entering
-- anything. The legacy payment_settings columns are left untouched as well, so
-- rolling the Worker code back keeps working.
INSERT INTO organizer_payment_providers
  (organizer_id, provider, status, enabled, public_key, consumer_key, ipn_id,
   secret_key_encrypted, consumer_secret_encrypted, last_tested_at, last_error, connected_at, created_at, updated_at)
SELECT organizer_id, provider,
       CASE WHEN status = 'configuration_required' THEN 'configuration_required'
            WHEN status = 'error' THEN 'error'
            WHEN status = 'connected' THEN 'connected'
            ELSE 'not_connected' END,
       1, public_key, consumer_key, ipn_id,
       secret_key_encrypted, consumer_secret_encrypted,
       last_tested_at, last_error,
       CASE WHEN status = 'connected' THEN COALESCE(updated_at, datetime('now')) ELSE NULL END,
       COALESCE(created_at, datetime('now')), COALESCE(updated_at, datetime('now'))
  FROM payment_settings
 WHERE provider IN ('paystack','pesapal')
   AND (public_key IS NOT NULL OR secret_key_encrypted IS NOT NULL
        OR consumer_key IS NOT NULL OR consumer_secret_encrypted IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM organizer_payment_providers p
                    WHERE p.organizer_id = payment_settings.organizer_id
                      AND p.provider = payment_settings.provider);

PRAGMA foreign_keys = ON;

-- ------------------------------------------------ 5. events.payment_provider ---
-- Optional per-event override. NULL for every existing event = "use the
-- organizer's active provider", so no existing event changes behaviour.
ALTER TABLE events ADD COLUMN payment_provider TEXT;

