-- 0031: minutes the owners actually spent on marketing, logged by hand. Plan rev 4, 09-28 build.
--
-- The case against the plan is that it asks two people for about two hours a week and the archive
-- shows three months of that not happening. Nothing measured it. This is the measurement: one row per
-- sitting, summed per person in the Monday email next to what the week produced.
--
-- Apply BY FILE (the D1 migration ledger drifts, memory d1-migration-ledger-drifts), then backfill the ledger.
CREATE TABLE IF NOT EXISTS marketing_time (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  day        TEXT NOT NULL,               -- YYYY-MM-DD, the day the work happened
  who        TEXT NOT NULL,               -- brycen | jayson | other
  minutes    INTEGER NOT NULL,            -- 1 to 600
  what       TEXT,                        -- one line, optional ("filmed reel", "marketplace renew")
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mtime_day ON marketing_time (day);
