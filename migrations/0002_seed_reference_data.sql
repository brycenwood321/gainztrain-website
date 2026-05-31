-- Seed the reference tables that the app + ops logic read but don't author at runtime.
-- Source of truth for zones/zips = functions/api/assign-delivery-zone.js (the live mapping).
-- Coupons mirror Stripe (gainz-train/CLAUDE.md "Active coupons"). stripe_price_id /
-- stripe_coupon_id are filled by the backfill step against the live Stripe account.
-- INSERT OR REPLACE so re-running is harmless.

-- ── Delivery zones (fees in integer cents) ───────────────────────────────────
INSERT OR REPLACE INTO delivery_zones (zone, name, fee_cents, stripe_price_id) VALUES
  (0, 'Pickup', 0,    NULL),
  (1, 'Zone 1', 1000, NULL),   -- Orem, Provo, Lindon, Vineyard, Pleasant Grove (<=5 mi)
  (2, 'Zone 2', 1500, NULL),   -- American Fork, Springville, Cedar Hills, Highland, Alpine, Mapleton (5-10 mi)
  (3, 'Zone 3', 2000, NULL),   -- Lehi, Spanish Fork, Salem, Saratoga Springs, Eagle Mountain (10-15 mi)
  (4, 'Zone 4', 2500, NULL);   -- Draper, Payson, Santaquin, Bluffdale, Riverton (15-25 mi)

-- ── Zip -> zone (Utah County), verbatim from assign-delivery-zone.js ─────────
INSERT OR REPLACE INTO zip_zone_map (zip, zone) VALUES
  -- Zone 1
  ('84057', 1), ('84058', 1), ('84097', 1),
  ('84601', 1), ('84602', 1), ('84603', 1), ('84604', 1), ('84605', 1), ('84606', 1),
  ('84042', 1), ('84062', 1),
  -- Zone 2
  ('84003', 2), ('84663', 2), ('84004', 2), ('84664', 2),
  -- Zone 3
  ('84043', 3), ('84660', 3), ('84653', 3), ('84045', 3), ('84005', 3),
  -- Zone 4
  ('84020', 4), ('84651', 4), ('84655', 4), ('84065', 4), ('84096', 4);

-- ── Coupons (mirror Stripe) ──────────────────────────────────────────────────
INSERT OR REPLACE INTO coupons (code, stripe_coupon_id, percent_off, duration, cap, expires_at, times_redeemed) VALUES
  ('OWNERS100',    NULL, 100, 'forever', 4,  NULL,                     0),  -- Brycen / Marissa / Jayson / Alyssa
  ('FAMFRIENDS15', NULL, 15,  'forever', 25, NULL,                     0),  -- immediate family + close friends
  ('FOUNDER25',    NULL, 25,  'once',    50, '2026-06-30T23:59:59Z',   0);  -- first invoice only, expires 6/30/2026
