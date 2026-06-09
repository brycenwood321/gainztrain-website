-- 0009: per-customer notification preferences (opt-outs). Transactional + security notifications
-- (receipts, payment failures, refunds, password changes, order confirmations/locks) ALWAYS send and
-- are NOT represented here — they can't be opted out of. Only 'account' (self-service confirmations)
-- and 'marketing' (menu drops, reminders, renewal heads-up) are controllable. No row = all defaults.
CREATE TABLE notification_prefs (
  customer_id     TEXT PRIMARY KEY REFERENCES customers(id),
  email_account   INTEGER NOT NULL DEFAULT 1,   -- pause/resume/cancel/tier/delivery/goal confirmations
  email_marketing INTEGER NOT NULL DEFAULT 1,   -- "menu is live", reminders, renewal heads-up
  sms_account     INTEGER NOT NULL DEFAULT 1,
  sms_marketing   INTEGER NOT NULL DEFAULT 0,   -- SMS marketing default OFF (TCPA-safe)
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
