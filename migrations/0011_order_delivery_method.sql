-- 0011: freeze the delivery method onto the order at lock time. Without this, the delivery tracker /
-- route / "out for delivery" logic reads the customer's LIVE delivery_method, so a customer who flips
-- pickup<->delivery after the Saturday lock would mis-target an order the kitchen already committed.
-- Snapshotted by admin/lock-week.js; consumers COALESCE(o.delivery_method, c.delivery_method) for
-- any pre-snapshot order.
ALTER TABLE orders ADD COLUMN delivery_method TEXT;
