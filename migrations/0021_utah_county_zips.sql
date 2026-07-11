-- 0021: Complete Utah County zip coverage (2026-07-11). Brycen report: Vineyard "not found" at
-- checkout — 84059 was missing from zip_zone_map entirely. Full-county audit added the rest.
-- Zones by distance from the Orem kitchen (1: ≤5mi, 2: 5-10, 3: 10-15, 4: 15-25).
INSERT OR IGNORE INTO zip_zone_map (zip, zone) VALUES
  ('84059', 1),  -- Vineyard (the reported bug)
  ('84013', 4),  -- Cedar Fort
  ('84633', 4),  -- Goshen
  ('84626', 4);  -- Elberta
