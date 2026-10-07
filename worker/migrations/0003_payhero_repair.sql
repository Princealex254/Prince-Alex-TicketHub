-- ============================================================================
-- Prince Alex TicketHub - migration 0003: finish a part-way PayHero migration
-- Powered by Prince Alex Digital
-- ----------------------------------------------------------------------------
-- Why this file exists
--   0002_payhero.sql adds its three new payments columns in one block, and D1
--   runs the statements of a --file one at a time, stopping at the first one
--   that fails (nothing after it runs, and nothing before it is rolled back).
--   A database can therefore end up with SOME of the new columns present - and
--   because "ALTER TABLE ... ADD COLUMN" cannot be guarded, re-running 0002
--   stops at the same "duplicate column name" every time and never gets past
--   it:
--
--       ALTER TABLE payments ADD COLUMN failure_reason TEXT;   <-- stops here
--       ... the columns after it, the rebuilds and the provider table below it
--           never run
--
--   This file does that leftover work, one statement at a time:
--
--     1. organizer_payment_providers   the per-provider table, its indexes and
--                                      the backfill from payment_settings
--                                      (IF NOT EXISTS / NOT EXISTS guarded, so
--                                      it is safe to run at any time)
--     2. payments.provider_metadata    one ALTER per column, and
--        payments.failure_reason      provider_metadata comes first because it
--        payments.failure_at          is the column that stops checkout when it
--                                     is missing (routeInitiatePayment stores
--                                     the provider reference and metadata with
--                                     it)
--     3. events.payment_provider       the optional per-event override
--
--   Every statement only ever ADDS something: no payment, order, ticket or
--   credential row is updated, moved or deleted. There is deliberately no table
--   rebuild here - a database whose CHECK constraints are still the pre-PayHero
--   ones is finished off by 0004_payhero_check_rebuild.sql, which is a separate
--   file precisely so that adding a column can never block the rebuild.
--
-- How to run it
--   Remote : wrangler d1 execute princealextickethub --remote --file=worker/migrations/0003_payhero_repair.sql
--   Local  : wrangler d1 execute princealextickethub --local  --file=worker/migrations/0003_payhero_repair.sql
--
--   If the run stops at "duplicate column name: X", then X is already there and
--   the statements after it did not run. Run the ones that are still missing on
--   their own, one command each, so an already-applied column cannot hold up the
--   rest ("duplicate column name" means "nothing to do", never "broken"):
--     wrangler d1 execute princealextickethub --remote --command "ALTER TABLE payments ADD COLUMN provider_metadata TEXT;"
--     wrangler d1 execute princealextickethub --remote --command "ALTER TABLE payments ADD COLUMN failure_reason TEXT;"
--     wrangler d1 execute princealextickethub --remote --command "ALTER TABLE payments ADD COLUMN failure_at TEXT;"
--     wrangler d1 execute princealextickethub --remote --command "ALTER TABLE events ADD COLUMN payment_provider TEXT;"
--
-- Verify afterwards
--   wrangler d1 execute princealextickethub --remote --command "PRAGMA table_info(payments);"
--   wrangler d1 execute princealextickethub --remote --command "SELECT name FROM sqlite_master WHERE name = 'organizer_payment_providers';"
--   wrangler d1 execute princealextickethub --remote --command "SELECT organizer_id, provider, status FROM organizer_payment_providers;"
--   and GET /api/health: payment_schema.ready is true with an empty "missing"
--   list. Then check the provider CHECK - if payments still reads
--       CHECK (provider IN ('paystack','pesapal'))
--   run 0004_payhero_check_rebuild.sql, or PayHero cannot take money.
-- ============================================================================

PRAGMA foreign_keys = OFF;

-- ---------------------------- 1. organizer_payment_providers (only if absent) -
-- Identical to step 3 of 0002_payhero.sql. CREATE TABLE IF NOT EXISTS means a
-- database that already has the table (the usual part-way state) keeps every
-- row exactly as it is; only the indexes and the guarded backfill are re-tried.
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

-- Backfill, exactly as step 4 of 0002_payhero.sql: an organizer who connected
-- Pesapal or Paystack before PayHero existed shows as Connected without
-- re-entering anything. The NOT EXISTS guard makes it a no-op when the row is
-- already there, so nothing is ever duplicated or overwritten.
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

-- ------------------------------- 2. the payments columns, one ALTER each -----
-- provider_metadata first: this is the column whose absence turned "pay for my
-- ticket" into "no such column: provider_metadata at offset 114" on checkout
-- (routeInitiatePayment stores the provider reference, the response snapshot
-- and the provider metadata in one UPDATE after the gateway call succeeds).
ALTER TABLE payments ADD COLUMN provider_metadata TEXT;
ALTER TABLE payments ADD COLUMN failure_reason TEXT;
ALTER TABLE payments ADD COLUMN failure_at TEXT;

-- ----------------------------------------------- 3. events.payment_provider ---
-- Optional per-event override; NULL for every existing event means "use the
-- organizer's active provider", so no existing event changes behaviour.
ALTER TABLE events ADD COLUMN payment_provider TEXT;

PRAGMA foreign_keys = ON;
