-- 0029: why a customer paused or cancelled, written in the SAME statement as the status change so a
-- pause can never exist without its reason (or an explicit "declined to say"). Plan rev 4, 09-28 build.
--
-- Thirteen customers paused between 08-26 and 09-13 and nobody knew why until Brycen texted all of
-- them by hand on 09-14. This is the column that makes that text unnecessary next time.
--
--   reason_kind   pause | cancel        which action the reason belongs to
--   reason_code   one of functions/_lib/reasons.js (pickup_time, too_much_food, price, menu, delivery,
--                 break, other) or 'declined' when they tapped through without picking
--   reason_text   their own words, optional, 280 chars max
--   reason_at     ISO-8601 UTC
--
-- The full history lives in audit_log (owner_paused / owner_canceled detail_json carries the same
-- fields); these columns are the LATEST reason, for the ops Customers column and the Monday email.
--
-- Apply BY FILE (the D1 migration ledger drifts, memory d1-migration-ledger-drifts), then backfill the ledger.
ALTER TABLE subscriptions ADD COLUMN reason_kind TEXT;
ALTER TABLE subscriptions ADD COLUMN reason_code TEXT;
ALTER TABLE subscriptions ADD COLUMN reason_text TEXT;
ALTER TABLE subscriptions ADD COLUMN reason_at TEXT;
