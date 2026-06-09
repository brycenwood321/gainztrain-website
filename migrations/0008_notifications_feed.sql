-- 0008: in-app notification feed. Every notify() that actually sends also drops a row here, so the
-- customer has a durable, in-app history (the bell in /app) even when email lands in spam. This table
-- is the DISPLAY feed only — idempotency still lives on comms_log.dedup_key (migration 0007), so a
-- deduped notify writes nothing here either.
CREATE TABLE notifications (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  event_key   TEXT NOT NULL,                 -- e.g. paused | order_confirmed | payment_failed
  title       TEXT NOT NULL,                 -- the email subject (short, human)
  body        TEXT,                          -- a one-line plain-text summary
  href        TEXT,                          -- deep link into the app (/app/menu/, /app/manage/, ...)
  category    TEXT,                          -- account | billing | order | menu
  read_at     TEXT,                          -- NULL = unread
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_notifications_customer ON notifications(customer_id, created_at DESC);
