-- 0032: referrals (give 2, get 2) and the NEW apply-to-existing-subscription credit path. Plan rev 4.
--
-- FUEL8 is a Stripe coupon attached at Checkout, so it can only ever touch a NEW subscription and can
-- never reward the person who did the referring (memory gt-fuel8-cap-leaks-past-four-weeks). This is
-- the other path: a meal credit sits in subscription_credits until that subscription's next lock,
-- where lock-week attaches it to the draft invoice as a NEGATIVE invoice item (same slot and same
-- helper shape as the specialty upcharge, capped at the draft total so no balance ever rolls forward).
-- The week-4 bonus (plan, 10-05) rides the same table with kind='week4_bonus'.
--
--   customers.referral_code   e.g. ZAC-7K2Q, minted on first request, unique
--   referrals                 one row per referred customer; credited when their FIRST order is paid
--   subscription_credits      pending -> applied (invoice_id, week_of, amount_cents) | void
--
-- Apply BY FILE (the D1 migration ledger drifts, memory d1-migration-ledger-drifts), then backfill the ledger.
ALTER TABLE customers ADD COLUMN referral_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_referral_code ON customers (referral_code);

CREATE TABLE IF NOT EXISTS referrals (
  id                    TEXT PRIMARY KEY,
  code                  TEXT NOT NULL,
  referrer_customer_id  TEXT NOT NULL,
  referred_customer_id  TEXT NOT NULL UNIQUE,
  status                TEXT NOT NULL DEFAULT 'pending',   -- pending | credited | void
  created_at            TEXT NOT NULL,
  credited_at           TEXT,
  void_reason           TEXT
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals (referrer_customer_id);

CREATE TABLE IF NOT EXISTS subscription_credits (
  id               TEXT PRIMARY KEY,
  subscription_id  TEXT NOT NULL,
  customer_id      TEXT NOT NULL,
  kind             TEXT NOT NULL,        -- referral_referrer | referral_referred | week4_bonus
  meals            INTEGER NOT NULL,
  ref_id           TEXT,                 -- referrals.id when kind starts with referral_
  status           TEXT NOT NULL DEFAULT 'pending',   -- pending | applied | void
  created_at       TEXT NOT NULL,
  applied_at       TEXT,
  invoice_id       TEXT,
  week_of          TEXT,
  amount_cents     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_subcredits_sub_status ON subscription_credits (subscription_id, status);
