-- 0020: Full-funnel marketing tracking (GT_MARKETING_PLAN §6 Phase 1 completion, 2026-07-09).
-- page_views: first-party, PII-free view beacon from public pages (no cookies, no IP) — gives
--   views → leads → customers in ONE database without waiting on GA4/pixel setup.
-- marketing_spend: manual spend log (per day/channel) until Phase 2 API ingestion replaces it.
--   Together with attribution + payments these complete the money query: spend → views → signups
--   → paying customers → revenue → CPL/CAC per channel.
CREATE TABLE page_views (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  day           TEXT NOT NULL,             -- YYYY-MM-DD UTC
  path          TEXT,
  utm_source    TEXT,
  utm_medium    TEXT,
  utm_campaign  TEXT,
  utm_content   TEXT,
  referrer_host TEXT,
  is_returning  INTEGER NOT NULL DEFAULT 0, -- visitor already had a stored first-touch
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_page_views_day ON page_views (day);
CREATE INDEX idx_page_views_source ON page_views (utm_source);

CREATE TABLE marketing_spend (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  day         TEXT NOT NULL,               -- YYYY-MM-DD
  channel     TEXT NOT NULL,               -- meta|google|gbp|tiktok|marketplace|other
  campaign    TEXT,
  spend_cents INTEGER NOT NULL,
  notes       TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_spend_day ON marketing_spend (day, channel);
