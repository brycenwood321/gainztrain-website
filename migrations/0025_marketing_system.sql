-- 0025: Marketing measurement system — make every ad dollar attributable to a DECISION
-- (offer, hook, placement, audience), not just to a UTM string.
--
-- WHY: the founders ad spent $167.01 over 3 weeks and the central question was unanswerable —
-- which offer/hook/placement/audience caused a signup? page_views/analytics_sessions/attribution
-- already capture dwell, scroll, geo, device and UTMs, but nothing records the marketing decision
-- behind a visit. Budget will grow; this makes future spend measurable BY CONSTRUCTION rather
-- than reconstructed after the fact.
--
-- DESIGN: the ad carries only identifiers (ad_id + the landing offer). All MEANING lives in the
-- marketing_variants registry, so adding a new dimension later (e.g. "season", "creator") is one
-- ALTER on a small table instead of a migration on the hot analytics path.
--
-- ⚠️ D1 REMOTE APPLY GOTCHA (same as 0024): D1 prepares every statement in a --file against the
-- ORIGINAL schema, so a CREATE INDEX referencing an ALTER-added column fails ("no such column").
-- APPLY IN TWO PASSES: run the PASS A block first, THEN the PASS B block. Do not run as one file.
--
-- Additive only. No column is dropped, no existing column changes type, everything is nullable,
-- so already-collected rows stay valid and simply read NULL for the new dimensions.

-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- PASS A — new columns (run this block ALONE, first)
-- ══════════════════════════════════════════════════════════════════════════════════════════════

-- Session-level first touch. The first pageview of a session writes these ONCE and every later
-- pageview inherits them — this is what survives the /fuel/ -> /menu UTM drop (see 0024).
ALTER TABLE analytics_sessions ADD COLUMN offer  TEXT;   -- landing offer shown: guarantee|2free|gainz50|menu
ALTER TABLE analytics_sessions ADD COLUMN ad_id  TEXT;   -- Meta {{ad.id}} — stable join key to marketing_variants

-- Customer-level. Carried from the gt_attr localStorage first touch at signup so the dimension
-- survives all the way to "this customer paid."
ALTER TABLE attribution ADD COLUMN offer TEXT;
ALTER TABLE attribution ADD COLUMN ad_id TEXT;

-- Spend gets keyed per-AD, not just per-channel, so it joins to the registry and to sessions.
ALTER TABLE marketing_spend ADD COLUMN ad_id       TEXT;
ALTER TABLE marketing_spend ADD COLUMN ad_name     TEXT;
ALTER TABLE marketing_spend ADD COLUMN impressions INTEGER;
ALTER TABLE marketing_spend ADD COLUMN link_clicks INTEGER;

-- NOTE: `placement` deliberately gets NO new column. Meta's {{placement}} macro rides in the
-- existing (previously unused) utm_term on both analytics_sessions and attribution.

-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- PASS B — new tables + indexes (run this block SECOND, after PASS A has applied)
-- ══════════════════════════════════════════════════════════════════════════════════════════════

-- The registry. One row per ad (or per ad x landing combination). This is the only place a human
-- edits marketing meaning; reports JOIN to it rather than parsing UTM strings.
CREATE TABLE IF NOT EXISTS marketing_variants (
  key             TEXT PRIMARY KEY,  -- Meta ad_id where one exists (stable); a slug for non-Meta
  channel         TEXT,              -- meta | google | organic | flyer | email | sms | referral
  platform        TEXT,              -- facebook | instagram | tiktok | google
  campaign        TEXT,
  ad_name         TEXT,
  hook            TEXT,              -- the opening angle: "founders why", "cost per meal"
  creative_type   TEXT,              -- founders-video | dish-video | photo | carousel | ugc
  offer           TEXT,              -- guarantee | fuel8 | gainz50 | none
  audience        TEXT,              -- broad-utah-county | gym-owners | college-students
  landing_path    TEXT,              -- /fuel/
  landing_variant TEXT,              -- the ?v= value this ad points at (must match `offer`)
  status          TEXT NOT NULL DEFAULT 'draft',  -- draft | live | paused | retired
  -- Geo the ad actually targets (e.g. 'Utah'). Reports exclude paid sessions from outside it.
  -- Added 2026-08-05 after publishing an ad edit produced 6 "sessions" in 34 seconds from Prineville
  -- OR, Boardman OR, Forest City NC, Gallatin TN and Fort Worth TX — every one a Meta data center,
  -- all reporting placement Facebook_Right_Column which this campaign explicitly EXCLUDES. That is
  -- Meta's ad-review crawler fetching the landing page, not people. Left in the table (crawler volume
  -- is worth seeing) but filtered out of every funnel rate, or it silently inflates the denominator.
  target_region   TEXT,
  launched_at     TEXT,
  retired_at      TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mv_status   ON marketing_variants (status);
CREATE INDEX IF NOT EXISTS idx_mv_offer    ON marketing_variants (offer);
CREATE INDEX IF NOT EXISTS idx_mv_audience ON marketing_variants (audience);

-- Every change that could move the numbers, with an exact cut line. Without this, a before/after
-- read is a guess — and GT changed the landing page and filmed a new ad in the same week.
CREATE TABLE IF NOT EXISTS marketing_changes (
  id         TEXT PRIMARY KEY,       -- slug, e.g. 2026-08-02-fuel-guarantee-and-hero
  cut_at     TEXT NOT NULL,          -- UTC ISO-8601. Compare directly against page_views.day (UTC).
  surface    TEXT,                   -- /fuel/ | ad-creative | offer | pricing | email
  channel    TEXT,
  summary    TEXT NOT NULL,
  detail     TEXT,                   -- JSON: what changed, the before-baseline, caveats
  commit_sha TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mc_cut ON marketing_changes (cut_at);

-- Indexes on the PASS A columns live here because they reference ALTER-added columns.
CREATE INDEX IF NOT EXISTS idx_asessions_offer ON analytics_sessions (offer);
CREATE INDEX IF NOT EXISTS idx_asessions_adid  ON analytics_sessions (ad_id);
CREATE INDEX IF NOT EXISTS idx_attr_offer      ON attribution (offer);
CREATE INDEX IF NOT EXISTS idx_attr_adid       ON attribution (ad_id);
CREATE INDEX IF NOT EXISTS idx_spend_adid      ON marketing_spend (day, ad_id);

-- Makes the nightly Meta pull idempotent: one row per ad per day, re-runnable, and correct when Meta
-- retroactively revises spend (it does). PARTIAL (WHERE ad_id IS NOT NULL) so the pre-existing
-- hand-entered rows — which have no ad_id — are untouched and can still be added freely.
CREATE UNIQUE INDEX IF NOT EXISTS uq_spend_day_ad ON marketing_spend (day, ad_id) WHERE ad_id IS NOT NULL;
