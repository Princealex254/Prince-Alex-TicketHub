-- ============================================================================
-- Prince Alex TicketHub - migration 0004: widen the provider CHECK constraints
-- Powered by Prince Alex Digital
-- ----------------------------------------------------------------------------
-- What this file is for
--   A CHECK constraint cannot be changed with ALTER TABLE, so the two tables
--   that hold a provider name have to be rebuilt before PayHero can be used:
--
--     payments.provider          CHECK (provider IN ('paystack','pesapal'))
--     payment_settings.provider  CHECK (provider IN ('paystack','pesapal'))
--     payment_settings.status    ... and the 'configuration_required' state
--
--   0002_payhero.sql does exactly this as its step 1 and step 2. On a database
--   where 0002 stopped part-way (see 0003_payhero_repair.sql) those steps never
--   ran: the columns are supplied by 0003, and the rebuild is left to this file
--   - deliberately separate, because a rebuild needs every new column to exist
--   and an ALTER that collides would otherwise stop the run before reaching it.
--
--   Both tables are rebuilt the way 0002 does it: a scratch table is created
--   and filled from the live table BEFORE anything is dropped, so every
--   existing payment, provider reference, failure reason, status and encrypted
--   credential is carried over byte for byte. A failure part-way through leaves
--   the original table untouched (the scratch table is dropped first on the
--   next run). ids, the sqlite_sequence counters and every index are preserved.
--
-- Run it only after 0003 (or 0002) has finished, i.e. once
--   wrangler d1 execute princealextickethub --remote --command "PRAGMA table_info(payments);"
-- lists provider_metadata, failure_reason and failure_at. Then:
--   Remote : wrangler d1 execute princealextickethub --remote --file=worker/migrations/0004_payhero_check_rebuild.sql
--   Local  : wrangler d1 execute princealextickethub --local  --file=worker/migrations/0004_payhero_check_rebuild.sql
--
-- Verify afterwards
--   wrangler d1 execute princealextickethub --remote --command "SELECT sql FROM sqlite_master WHERE name IN ('payments','payment_settings');"
--   both CREATE TABLE statements must now list 'payhero'.
--   wrangler d1 execute princealextickethub --remote --command "SELECT COUNT(*) AS n FROM payments;"
--   must match what it reported before the rebuild.
--   and GET /api/health must still report payment_schema.ready true.
-- ============================================================================

PRAGMA foreign_keys = OFF;

-- ------------------------------------------------------------- 1. payments ---
-- Rebuild with the wider provider CHECK. "DROP TABLE IF EXISTS payments_new"
-- first, so an interrupted run cannot leave a stale scratch table behind.
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
-- Every existing row is carried over byte for byte.
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

PRAGMA foreign_keys = ON;
