-- 0007: idempotency key for customer notifications.
--
-- WHY: the Stripe webhook (functions/api/stripe-webhook.js) processes at-least-once — on a mirror
-- failure it DELETES its lock row and returns 500 so Stripe retries, which re-runs dispatch(). Without
-- a guard, every billing notification fired from dispatch() would re-send on each retry (the same bug
-- class that ballooned the old GHL queue to 1,830 duplicate messages in May 2026).
--
-- HOW: notify() claims a row on a unique dedup_key BEFORE sending (event.id for billing, sub+week for
-- the order cycle). A second attempt with the same key hits the unique index, claims 0 rows, and skips
-- the send. SQLite treats NULLs as distinct in a UNIQUE index, so the many existing/simple sends
-- (welcome, magic link) keep a NULL dedup_key and never collide.
ALTER TABLE comms_log ADD COLUMN dedup_key TEXT;
CREATE UNIQUE INDEX idx_comms_dedup ON comms_log(dedup_key);
