-- ============================================================================
--  Prince Alex TicketHub - migration 0006
--  Free-ticket email OTP verification + IP-based abuse prevention
--  ----------------------------------------------------------------------------
--  Adds ONLY what the free-ticket verification feature needs. Paid tickets,
--  payments (Paystack / Pesapal / PayHero), QR issuance and every existing table
--  are untouched: nothing here is destructive and no ticket row is altered.
--
--  New columns on `events` (all backward compatible, with safe defaults so an
--  event created before this migration keeps working):
--      free_otp_enabled  1  -> claiming a free ticket requires an emailed OTP
--      free_ticket_limit 1  -> max free tickets per verified email, per event
--      ip_abuse_enabled  1  -> use the IP signals in the abuse-prevention layer
--      free_ticket_config   -> optional JSON of per-event rate thresholds,
--                              validated and clamped by the Worker
--
--  New tables:
--      free_ticket_sessions  one row per OTP verification session (hashed OTP)
--      free_ticket_claims    one row per free ticket slot actually claimed, with
--                            a PARTIAL UNIQUE index on (event_id,email_hash,slot)
--                            where status='active'. That index is what makes the
--                            per-email free-ticket limit concurrency-safe: two
--                            simultaneous requests cannot both take the same slot.
--
--  Privacy: no raw IP address is stored anywhere - only an HMAC hash. The free
--  ticket claim rows carry an email HASH, never the address itself. OTPs are
--  stored only as a keyed HMAC.
--
--  Apply (remote):
--      wrangler d1 execute princealextickethub --remote --file=worker/migrations/0006_free_ticket_otp.sql
--
--  Re-running is safe for the two tables (every statement is IF NOT EXISTS). The
--  four ALTER statements are last on purpose: on a database that already has the
--  columns the run stops at the first "duplicate column name" - by then the
--  tables and indexes have already been created, so nothing else is required.
--  Verify with:  SELECT name FROM sqlite_master WHERE name LIKE 'free_ticket_%';
--  and GET /api/health reports free_ticket_schema.ready.
-- ============================================================================

-- -------------------------------------------------- free ticket sessions -----
-- One row per verification session. `otp_hash` is HMAC(secret, "otp|<token>|<code>"),
-- so the six digits never exist in the database, in a log or in an API response.
CREATE TABLE IF NOT EXISTS free_ticket_sessions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    session_token       TEXT NOT NULL UNIQUE,   -- opaque reference returned to the client
    continue_hash       TEXT,                   -- salted hash of the continuation token
    event_id            INTEGER NOT NULL,
    email               TEXT NOT NULL,          -- normalised (trimmed + lower-cased)
    email_hash          TEXT NOT NULL,          -- HMAC(email) - used for lookups/stats
    name                TEXT,
    quantity            INTEGER NOT NULL DEFAULT 1,
    ticket_type_id      INTEGER,
    otp_hash            TEXT NOT NULL,          -- keyed HMAC of the 6-digit code
    attempts            INTEGER NOT NULL DEFAULT 0,
    resends             INTEGER NOT NULL DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'pending'   -- pending|verified|consumed|expired|superseded
                        CHECK (status IN ('pending','verified','consumed','expired','superseded')),
    ip_hash             TEXT,                   -- HMAC(ip) - never a raw address
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at          TEXT NOT NULL,          -- OTP expiry
    last_sent_at        TEXT,
    verified_at         TEXT,
    continue_expires_at TEXT,
    consumed_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_fts_continue     ON free_ticket_sessions(continue_hash);
CREATE INDEX IF NOT EXISTS idx_fts_event_email  ON free_ticket_sessions(event_id, email_hash, status);
CREATE INDEX IF NOT EXISTS idx_fts_status_exp   ON free_ticket_sessions(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_fts_event_status ON free_ticket_sessions(event_id, status);

-- ---------------------------------------------------- free ticket claims -----
-- One row per free ticket slot. Duplicate prevention counts the ACTIVE rows for
-- an event + email hash and refuses a claim once the event's configured limit is
-- reached. Rows are never deleted; a cancelled/refunded registration flips the
-- row to 'released', which frees its slot because the unique index only covers
-- active rows.
CREATE TABLE IF NOT EXISTS free_ticket_claims (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    INTEGER NOT NULL,
    email_hash  TEXT NOT NULL,
    slot        INTEGER NOT NULL,               -- 1..free_ticket_limit
    order_id    INTEGER,
    session_id  INTEGER,
    quantity    INTEGER NOT NULL DEFAULT 1,     -- tickets issued through this slot
    status      TEXT NOT NULL DEFAULT 'active'  -- active|released
                CHECK (status IN ('active','released')),
    ip_hash     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
-- The concurrency guard: two isolates cannot take the same active slot.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ftc_active_slot ON free_ticket_claims(event_id, email_hash, slot) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_ftc_lookup   ON free_ticket_claims(event_id, email_hash, status);
CREATE INDEX IF NOT EXISTS idx_ftc_order    ON free_ticket_claims(order_id);
CREATE INDEX IF NOT EXISTS idx_ftc_created  ON free_ticket_claims(created_at);

-- ------------------------------------------------- event level config --------
-- Added last so a re-run always leaves the tables above in place first.
ALTER TABLE events ADD COLUMN free_otp_enabled  INTEGER NOT NULL DEFAULT 1;
ALTER TABLE events ADD COLUMN free_ticket_limit INTEGER NOT NULL DEFAULT 1;
ALTER TABLE events ADD COLUMN ip_abuse_enabled  INTEGER NOT NULL DEFAULT 1;
ALTER TABLE events ADD COLUMN free_ticket_config TEXT;
