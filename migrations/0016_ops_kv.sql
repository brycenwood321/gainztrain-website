-- 0016_ops_kv.sql
-- Shared, staff-owned key/value store for the prep dashboard (Marissa's Menu tab). Replaces browser
-- localStorage for data that MUST persist + be shared across all staff/devices: the meal library and
-- custom ingredients. localStorage is per-browser/per-device, so meals entered on one machine were
-- invisible on another (and looked "lost" after the laptop→website move). This table makes them durable
-- + team-wide. Read/written via the staff-gated /api/admin/ops-store endpoint (keys are whitelisted).
CREATE TABLE IF NOT EXISTS ops_kv (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
