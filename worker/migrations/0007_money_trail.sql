-- ============================================================================
--  Prince Alex TicketHub - Money trail (migration 0007)
--  Powered by Prince Alex Digital
-- ----------------------------------------------------------------------------
--  Every ORDER snapshots WHO collected the money at checkout time, so the
--  Owner and the Organizer always agree even when the event's payment_mode
--  is changed mid-sale:
--
--    orders.collected_via   'owner' | 'organizer' | NULL (legacy/unknown/free)
--    orders.payment_provider  gateway that served it (paystack|pesapal|payhero)
--    orders.provider_label    human label cached at checkout ("Paystack")
--
--  Backfill: old paid/pending rows keep collected_via NULL (= "unknown -
--  before tracking"). New checkout always writes it. Nothing is destructive.
--
--  Apply (remote):
--    wrangler d1 execute princealextickethub --remote --file=worker/migrations/0007_money_trail.sql
-- ============================================================================

PRAGMA foreign_keys = ON;

ALTER TABLE orders ADD COLUMN collected_via TEXT;
ALTER TABLE orders ADD COLUMN payment_provider TEXT;
ALTER TABLE orders ADD COLUMN provider_label TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_collected_via ON orders(collected_via);
CREATE INDEX IF NOT EXISTS idx_orders_payment_provider ON orders(payment_provider);
CREATE INDEX IF NOT EXISTS idx_orders_event_collected ON orders(event_id, collected_via);
