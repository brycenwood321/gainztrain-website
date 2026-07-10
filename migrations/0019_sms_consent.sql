-- 0019: SMS marketing consent capture (A2P 10DLC resubmission package, 2026-07-09).
-- Express written consent for promotional texts is collected via an UNCHECKED checkbox on /start
-- (voluntary, not a condition of purchase — carrier requirement). We store the flag + timestamp so
-- every marketing send has TCPA-grade proof of when and where consent was given.
ALTER TABLE customers ADD COLUMN sms_marketing_consent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN sms_consent_at TEXT;
