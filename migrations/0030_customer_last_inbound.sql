-- 0030: the last thing a customer SAID to us, cached from GoHighLevel. Plan rev 4, 09-28 build.
--
-- Brycen texted 13 paused customers on 09-14 and their answers live only in GHL conversations, which
-- nothing in this app reads. The ops Customers tab and the Monday email need them next to the reason
-- column. /api/admin/inbound-sync fills these on the 13:00 UTC cron (one GHL search + one messages
-- read per customer, so it runs in small passes); the columns are a cache, GHL stays the truth.
--
--   last_inbound_at        ISO-8601 UTC of the newest inbound SMS or email (TYPE_ACTIVITY rows never count)
--   last_inbound_text      first 280 chars of it
--   last_inbound_channel   sms | email | other
--   inbound_synced_at      when the cache was last refreshed for this customer (NULL = never looked)
--
-- Apply BY FILE (the D1 migration ledger drifts, memory d1-migration-ledger-drifts), then backfill the ledger.
ALTER TABLE customers ADD COLUMN last_inbound_at TEXT;
ALTER TABLE customers ADD COLUMN last_inbound_text TEXT;
ALTER TABLE customers ADD COLUMN last_inbound_channel TEXT;
ALTER TABLE customers ADD COLUMN inbound_synced_at TEXT;
