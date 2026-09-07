-- 0028: the lock now charges BEFORE it writes an order as locked (2026-09-06, "bill at the lock").
-- These three columns record what the money did for this order, written in the same statement as
-- status='locked', so an order row can never say "locked" without also saying what happened to the charge.
--
--   charge_status  paid | comp | declined | legacy_anchor | unpaid_not_cooked   (NULL = the lock has not
--                  reached this order yet; the lock endpoint selects on IS NULL so a re-run resumes)
--   invoice_id     the Stripe invoice the lock finalized and paid (or tried to)
--   charged_at     ISO-8601 UTC, when the lock read the outcome
--
-- Apply BY FILE (the D1 migration ledger drifts, memory d1-migration-ledger-drifts), then backfill the ledger.
ALTER TABLE orders ADD COLUMN charge_status TEXT;
ALTER TABLE orders ADD COLUMN invoice_id TEXT;
ALTER TABLE orders ADD COLUMN charged_at TEXT;
