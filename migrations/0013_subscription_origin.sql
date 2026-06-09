-- 0013: mark each subscription's origin so the new cron/email/order machinery can ONLY ever touch
-- app-native customers, never the existing GHL-funnel customers. Until now the legacy subs were
-- protected only by the accident that meals_per_week=0; running enrich-ghl would drop that shield and
-- the next autonomous Saturday cron would auto-fill orders + email real customers about an app they've
-- never used. All EXISTING subs are legacy (created via the old GHL funnel). mirrorSubscription stamps
-- 'app' going forward when the Stripe sub carries our checkout's metadata.d1_customer_id.
ALTER TABLE subscriptions ADD COLUMN origin TEXT NOT NULL DEFAULT 'legacy';
