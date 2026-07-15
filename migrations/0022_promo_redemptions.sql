-- 0022_promo_redemptions.sql
-- Tracks per-customer redemption of special promo codes (currently FUEL8: 2 free meals/week x 4 weeks).
-- Serves two jobs: (1) enforce ONCE-PER-CUSTOMER (checkout blocks a code the customer already used, even
-- after they cancel + resubscribe), and (2) COUNT the discounted weeks so the webhook removes the
-- discount after exactly 4. One row per (customer, code).
CREATE TABLE IF NOT EXISTS promo_redemptions (
  customer_id        TEXT NOT NULL,
  code               TEXT NOT NULL,
  subscription_id    TEXT,
  weeks_discounted   INTEGER NOT NULL DEFAULT 0,
  first_redeemed_at  TEXT NOT NULL,
  last_applied_at    TEXT,
  PRIMARY KEY (customer_id, code)
);
