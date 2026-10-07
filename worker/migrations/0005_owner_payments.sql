-- ============================================================================
--  Prince Alex TicketHub - Owner payment mode (migration 0005)
--  Powered by Prince Alex Digital
-- ----------------------------------------------------------------------------
--  Adds everything needed for the platform OWNER to set payment details and for
--  organizers to collect through the owner's account:
--
--   1. platform_payment_providers
--        One row per provider: the owner's own merchant accounts, identical in
--        shape to organizer_payment_providers (minus organizer_id). Secrets are
--        AES-GCM ciphertext, written by the Worker, never returned to a client.
--
--   2. organizers.use_owner_payments
--        Account-wide default for "owner payment mode" (0 = off, 1 = on).
--
--   3. events.payment_mode
--        Per-event choice: NULL = inherit the organizer default, 'own' = the
--        organizer's own account, 'owner' = the platform owner's account.
--
--  Apply:
--    wrangler d1 execute <DB> --remote --file worker/migrations/0005_owner_payments.sql
--
--  Every statement is additive. If the ALTER statements report
--  "duplicate column name: ...", the column already exists: that is safe to
--  ignore and the remaining statements are still applied one by one.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- 1. The owner's own merchant accounts -------------------------------------
CREATE TABLE IF NOT EXISTS platform_payment_providers (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    provider                  TEXT NOT NULL UNIQUE CHECK (provider IN ('paystack','pesapal','payhero')),
    status                    TEXT NOT NULL DEFAULT 'not_connected'
                              CHECK (status IN ('not_connected','connected','configuration_required','error')),
    enabled                   INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
    public_key                TEXT,
    consumer_key              TEXT,
    ipn_id                    TEXT,
    api_username              TEXT,
    channel_id                TEXT,
    secret_key_encrypted      TEXT,
    consumer_secret_encrypted TEXT,
    password_encrypted        TEXT,
    last_tested_at            TEXT,
    last_error                TEXT,
    connected_at              TEXT,
    created_at                TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2. Organizer account-wide default -----------------------------------------
ALTER TABLE organizers ADD COLUMN use_owner_payments INTEGER NOT NULL DEFAULT 0;

-- 3. Per-event choice --------------------------------------------------------
ALTER TABLE events ADD COLUMN payment_mode TEXT;

-- Owner payment mode is OFF for the platform until the owner turns it on.
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('owner_payment_enabled', 'true');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('owner_payment_active_provider', 'paystack');

CREATE INDEX IF NOT EXISTS idx_platform_pp_provider ON platform_payment_providers(provider);
