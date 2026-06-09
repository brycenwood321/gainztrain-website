-- 0010: delivery tracker. Adds a delivery lifecycle to the weekly order (separate from the order
-- `status` pending|locked|prepped which tracks the kitchen side) plus a public tracking token and
-- customer geo for the route map. delivery_status values (validated in code, no CHECK so it stays
-- additive): prepping | out_for_delivery | delivered | pickup_ready | picked_up.
ALTER TABLE orders ADD COLUMN delivery_status TEXT;
ALTER TABLE orders ADD COLUMN delivery_eta    TEXT;   -- ISO, optional window/ETA
ALTER TABLE orders ADD COLUMN delivered_at    TEXT;   -- ISO, set when delivered / picked up
ALTER TABLE orders ADD COLUMN tracking_token  TEXT;   -- opaque token for the public /app/track page
CREATE INDEX idx_orders_tracking ON orders(tracking_token);

-- For the delivery route map (geocoded later; null until then). zip_zone_map already gives the zone.
ALTER TABLE customers ADD COLUMN lat REAL;
ALTER TABLE customers ADD COLUMN lng REAL;
