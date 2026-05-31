-- Expand subscriptions.status CHECK to Stripe's FULL status enum.
-- The original set (active/paused/canceled/past_due/incomplete) was missing
-- incomplete_expired / trialing / unpaid, which silently broke the backfill mirror
-- for real subscriptions. Stripe is the authority on valid statuses; the CHECK must
-- never reject a real one. SQLite can't ALTER a CHECK, so rebuild the table.
-- Subscription ids are preserved, so FK references from invoices/orders/meal_selections stay valid.
PRAGMA defer_foreign_keys = TRUE;

ALTER TABLE subscriptions RENAME TO _subscriptions_old;

CREATE TABLE subscriptions (
  id                      TEXT PRIMARY KEY,
  customer_id             TEXT NOT NULL REFERENCES customers(id),
  stripe_subscription_id  TEXT UNIQUE,
  status                  TEXT NOT NULL DEFAULT 'incomplete'
                            CHECK (status IN ('active','paused','canceled','past_due','incomplete','incomplete_expired','trialing','unpaid')),
  meals_per_week          INTEGER NOT NULL,
  tier_price_cents        INTEGER,
  current_period_start    TEXT,
  current_period_end      TEXT,
  cancel_at_period_end    INTEGER NOT NULL DEFAULT 0,
  paused_at               TEXT,
  coupon_code             TEXT,
  discount_active         INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

INSERT INTO subscriptions SELECT * FROM _subscriptions_old;
DROP TABLE _subscriptions_old;
CREATE INDEX idx_subs_customer ON subscriptions(customer_id);
CREATE INDEX idx_subs_status   ON subscriptions(status);
