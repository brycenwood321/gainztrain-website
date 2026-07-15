-- 0023_promo_invoice_ledger.sql
-- Per-invoice idempotency for promo week-counting. The Stripe webhook can re-deliver / reprocess an
-- invoice.paid event; without this, the FUEL8 week counter could increment twice and cut the discount
-- short. Each invoice is recorded once (INSERT OR IGNORE); only a freshly-inserted row counts a week.
CREATE TABLE IF NOT EXISTS promo_invoice_ledger (
  invoice_id   TEXT PRIMARY KEY,
  customer_id  TEXT,
  code         TEXT,
  at           TEXT NOT NULL
);
