-- Promo-code hardening: only customer-facing codes may be typed at checkout. OWNERS100 is an
-- internal owner comp (100% off forever) and must NOT be applicable by a random logged-in customer.
ALTER TABLE coupons ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;
UPDATE coupons SET is_public = 1 WHERE code IN ('FAMFRIENDS15', 'FOUNDER25');
-- OWNERS100 intentionally stays is_public = 0 (comp owners via the admin/Stripe path, not the public field).
