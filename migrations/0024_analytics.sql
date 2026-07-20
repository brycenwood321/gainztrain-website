-- Rich first-party web analytics: sessions + events + engagement metrics on page_views.
-- Everything here is first-party and anonymous: random visitor/session ids (no PII, no IP stored),
-- with geo (country/region/city) and device/browser/os derived server-side from the Cloudflare
-- request + user-agent. Powers the ops Analytics tab. Additive only — no existing column/table changes.
--
-- ⚠️ D1 REMOTE APPLY GOTCHA: D1 prepares every statement in a --file against the ORIGINAL schema, so a
-- CREATE INDEX on a column added by an ALTER in the SAME file fails ("no such column"). Apply in two
-- passes: run the ALTER TABLE block first, THEN the CREATE INDEX / CREATE TABLE block. (Applied to the
-- live DB 2026-07-20 that way.)

-- 1) Engagement + linkage columns on the existing page-view stream.
--    pv_id = client-generated id so the on-unload beacon can find its own row to fill dwell/scroll.
ALTER TABLE page_views ADD COLUMN pv_id          TEXT;
ALTER TABLE page_views ADD COLUMN visitor_id     TEXT;
ALTER TABLE page_views ADD COLUMN session_id     TEXT;
ALTER TABLE page_views ADD COLUMN title          TEXT;
ALTER TABLE page_views ADD COLUMN dwell_ms       INTEGER;   -- active time on page (visibility-aware)
ALTER TABLE page_views ADD COLUMN max_scroll_pct INTEGER;   -- deepest scroll reached (0-100)
ALTER TABLE page_views ADD COLUMN is_entry       INTEGER DEFAULT 0;  -- first pageview of its session
ALTER TABLE page_views ADD COLUMN device         TEXT;      -- mobile | tablet | desktop | bot
ALTER TABLE page_views ADD COLUMN country        TEXT;
ALTER TABLE page_views ADD COLUMN region         TEXT;
ALTER TABLE page_views ADD COLUMN city           TEXT;
CREATE INDEX IF NOT EXISTS idx_pv_pvid    ON page_views(pv_id);
CREATE INDEX IF NOT EXISTS idx_pv_session ON page_views(session_id);
CREATE INDEX IF NOT EXISTS idx_pv_visitor ON page_views(visitor_id);

-- 2) Analytics sessions — one row per visit (30-min inactivity window). The FIRST pageview writes the
--    entry source ONCE here; every later pageview in the session inherits it. This is what makes the
--    whole funnel measurable after the utm drops off the URL (the /fuel -> /menu blind spot), because
--    attribution lives at the session level keyed to visitor_id, not on each page's query string.
--    ⚠️ NAMED analytics_sessions, NOT sessions — `sessions` already exists as the auth/login table
--    (customer_id, expires_at, revoked_at). Do not collide with it.
CREATE TABLE IF NOT EXISTS analytics_sessions (
  id                  TEXT PRIMARY KEY,          -- session_id
  visitor_id          TEXT,
  started_at          TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  entry_path          TEXT,
  entry_referrer_host TEXT,
  utm_source          TEXT,
  utm_medium          TEXT,
  utm_campaign        TEXT,
  utm_content         TEXT,
  utm_term            TEXT,
  fbclid              TEXT,
  gclid               TEXT,
  country             TEXT,
  region              TEXT,
  city                TEXT,
  device              TEXT,
  browser             TEXT,
  os                  TEXT,
  is_returning        INTEGER DEFAULT 0,
  pageviews           INTEGER DEFAULT 0,
  event_count         INTEGER DEFAULT 0,
  duration_ms         INTEGER DEFAULT 0,
  converted           INTEGER DEFAULT 0,         -- signup/purchase happened in this session
  customer_id         TEXT
);
CREATE INDEX IF NOT EXISTS idx_asessions_visitor  ON analytics_sessions(visitor_id);
CREATE INDEX IF NOT EXISTS idx_asessions_started  ON analytics_sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_asessions_campaign ON analytics_sessions(utm_campaign, utm_content);
CREATE INDEX IF NOT EXISTS idx_asessions_source   ON analytics_sessions(utm_source, utm_medium);

-- 3) Events — clicks, CTA clicks, scroll milestones, outbound links, funnel steps, custom.
CREATE TABLE IF NOT EXISTS analytics_events (
  id          TEXT PRIMARY KEY,
  session_id  TEXT,
  visitor_id  TEXT,
  type        TEXT NOT NULL,   -- click | cta | scroll | outbound | funnel | form | custom
  path        TEXT,
  label       TEXT,            -- CTA text / scroll milestone / funnel step name
  href        TEXT,            -- for link/outbound clicks
  value       INTEGER,         -- scroll % / count / cents
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session ON analytics_events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_type    ON analytics_events(type, created_at);
