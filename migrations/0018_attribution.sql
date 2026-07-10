-- 0018: Phase 1 marketing attribution (GT_MARKETING_PLAN_2026-07-08 §6).
-- One row per customer, stamped at account creation: first-touch UTMs / ad click-ids captured
-- client-side (localStorage, first touch wins) + the required self-reported "how did you hear
-- about us?" answer (catches dark social — Marketplace, group posts, word of mouth — that UTMs miss).
-- Joins to subscriptions/orders/payments for the money query: source → signups → revenue → CAC.
CREATE TABLE attribution (
  customer_id  TEXT PRIMARY KEY REFERENCES customers(id),
  utm_source   TEXT,
  utm_medium   TEXT,
  utm_campaign TEXT,
  utm_content  TEXT,
  utm_term     TEXT,
  gclid        TEXT,   -- Google Ads click id (present = paid Google click)
  fbclid       TEXT,   -- Meta click id (present = FB/IG click, paid or organic share)
  landing_path TEXT,   -- first page they hit, with query string
  referrer     TEXT,   -- external referrer on first touch
  self_reported        TEXT,  -- instagram|facebook|tiktok|google|friend|gym|other
  self_reported_detail TEXT,  -- optional free text (which friend / what "other" means)
  first_touch_at TEXT,        -- client-reported time the first touch was captured
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_attribution_utm_source ON attribution (utm_source);
CREATE INDEX idx_attribution_self ON attribution (self_reported);
