-- One-off: server-side rate limiting table.
-- Safe to run more than once (every statement is IF NOT EXISTS) and safe to run
-- while the Worker is live: the limiter degrades to its memory tier if the table
-- is briefly absent, and picks the table up on the next request.
--
--   wrangler d1 execute princealextickethub --file=worker/migrations/0001_rate_limits.sql
--
-- Verify afterwards:
--   wrangler d1 execute princealextickethub --command "SELECT name FROM sqlite_master WHERE name='rate_limits'"
-- and check GET /api/health reports rate_limit_store: "d1".

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
