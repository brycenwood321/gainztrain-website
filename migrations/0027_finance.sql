-- 0027: in-house bookkeeping (ops dashboard "Finance" tab, plan purrfect-humming-dolphin 2026-09-02).
-- Bank CSV rows + import batches + vendor->category rules + a per-month Stripe cache.
-- Money is integer cents; amount_cents < 0 = money OUT of the account. Timestamps ISO UTC.
-- Revenue never comes from bank rows (it comes from invoices/payments + the Stripe cache), so Stripe
-- payout deposits, transfers and owner draws are stored but excluded from every P&L sum.
-- Plain CREATE TABLEs with inline indexes on purpose: no ALTER, so the 0025 two-pass D1 gotcha cannot apply.
-- Raw CSV text is NEVER stored anywhere: the only R2 bucket is served publicly by meal-photos/[[path]].js.

CREATE TABLE IF NOT EXISTS finance_imports (
  id               TEXT PRIMARY KEY,
  account          TEXT NOT NULL,              -- checking | card
  filename         TEXT,
  mapping_json     TEXT NOT NULL,              -- detected column mapping + flip flag, for audit
  row_count        INTEGER NOT NULL,           -- data rows in the file
  inserted_count   INTEGER NOT NULL,
  duplicate_count  INTEGER NOT NULL,
  skipped_json     TEXT,                       -- {pending, bad_amount, bad_date}
  months_json      TEXT,                       -- {"2026-08": n, ...}
  sign_check_json  TEXT,                       -- {outflow_rows, inflow_rows, forced}
  created_by       TEXT,                       -- customer id of the owner who imported
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id               TEXT PRIMARY KEY,
  content_hash     TEXT NOT NULL UNIQUE,       -- sha256(account|posted_on|amount_cents|dedup_key|occurrence)
  import_id        TEXT NOT NULL REFERENCES finance_imports(id),
  account          TEXT NOT NULL,              -- checking | card
  posted_on        TEXT NOT NULL,              -- YYYY-MM-DD as printed by the bank
  month            TEXT NOT NULL,              -- YYYY-MM; the P&L bucket
  description_raw  TEXT NOT NULL,              -- untouched bank text (description [| memo])
  vendor_norm      TEXT NOT NULL,              -- normalized vendor string rules match against
  dedup_key        TEXT NOT NULL,              -- first 2 tokens of vendor_norm (survives re-export drift)
  amount_cents     INTEGER NOT NULL,           -- negative = money out
  category         TEXT NOT NULL DEFAULT 'uncategorized',
  category_source  TEXT NOT NULL DEFAULT 'none', -- none | rule | manual
  rule_id          INTEGER,
  note             TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bank_month_cat ON bank_transactions (month, category);
CREATE INDEX IF NOT EXISTS idx_bank_import    ON bank_transactions (import_id);
CREATE INDEX IF NOT EXISTS idx_bank_vendor    ON bank_transactions (vendor_norm);
CREATE INDEX IF NOT EXISTS idx_bank_daykey    ON bank_transactions (account, posted_on, dedup_key, amount_cents);

CREATE TABLE IF NOT EXISTS finance_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern     TEXT NOT NULL,                   -- matched against vendor_norm (uppercase)
  match_type  TEXT NOT NULL DEFAULT 'contains',-- contains | regex
  direction   TEXT NOT NULL DEFAULT 'any',     -- any | in | out  (in = amount > 0)
  category    TEXT NOT NULL,
  priority    INTEGER NOT NULL DEFAULT 50,     -- higher wins; ties -> lower id
  note        TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS finance_stripe_months (
  month             TEXT PRIMARY KEY,          -- YYYY-MM, UTC, by balance_transaction.created
  gross_cents       INTEGER NOT NULL DEFAULT 0,
  fees_cents        INTEGER NOT NULL DEFAULT 0, -- positive number
  refunds_cents     INTEGER NOT NULL DEFAULT 0, -- negative
  disputes_cents    INTEGER NOT NULL DEFAULT 0, -- negative
  payouts_cents     INTEGER NOT NULL DEFAULT 0, -- abs sum of payouts
  payout_count      INTEGER NOT NULL DEFAULT 0,
  txn_count         INTEGER NOT NULL DEFAULT 0,
  other_types_json  TEXT,                      -- {"type": {"n": 1, "amount_cents": -100}} for anything unhandled
  complete          INTEGER NOT NULL DEFAULT 0, -- 1 only when paging ended with has_more=false
  frozen            INTEGER NOT NULL DEFAULT 0, -- 1 only when complete AND the month is closed; ?force=1 re-syncs
  synced_at         TEXT NOT NULL
);

-- Seed rules. Conservative on purpose: exclusions are highest priority and unambiguous; vendor rules cover
-- the obvious kitchen suppliers; everything else stays uncategorized so it shows in the review list.
-- Amazon, Venmo and Zelle are deliberately NOT seeded (packaging vs equipment vs owner draw): review them.
INSERT INTO finance_rules (pattern, match_type, direction, category, priority, note, created_at) VALUES
  ('STRIPE', 'contains', 'in', 'stripe_payout', 100, 'Stripe payout deposit; revenue comes from D1/Stripe, never the bank', datetime('now')),
  ('PAYMENT.*THANK YOU|AUTOPAY|CARD PAYMENT|ONLINE PMT|ONLINE PAYMENT|CREDIT CARD PYMT|VISA PAYMENT', 'regex', 'any', 'transfer', 100, 'Card payment (both the checking debit and the card credit)', datetime('now')),
  ('TRANSFER|XFER|TFR', 'regex', 'any', 'transfer', 100, 'Between own accounts', datetime('now')),
  ('SERVICE CHARGE|MONTHLY FEE|OVERDRAFT|NSF|FOREIGN TRANS|ATM FEE|INTEREST CHARGE|LATE FEE', 'regex', 'out', 'fees', 90, 'Bank/card fees', datetime('now')),
  ('COSTCO|WALMART|WAL MART|SAMS CLUB|SAM S CLUB|WINCO|SMITHS|SMITH S|SPROUTS|RESTAURANT DEPOT|SYSCO|US FOODS|HARMONS|MACEY|KROGER', 'regex', 'any', 'food', 50, 'Grocers/wholesalers; override per row for equipment buys', datetime('now')),
  ('ULINE|WEBSTAURANT|PAPERMART|RESTAURANTWARE', 'regex', 'any', 'packaging', 50, NULL, datetime('now')),
  ('FACEBK|FACEBOOK|META PLATFORMS|METAPAY|GOOGLE ADS|TIKTOK ADS', 'regex', 'any', 'advertising', 60, NULL, datetime('now')),
  ('CLOUDFLARE|GOHIGHLEVEL|HIGHLEVEL|GITHUB|OPENAI|ANTHROPIC|GOOGLE WORKSPACE|GSUITE|CANVA|APPLE COM BILL|SQUARESPACE|GODADDY', 'regex', 'any', 'software', 60, NULL, datetime('now')),
  ('MAVERIK|CHEVRON|SINCLAIR|HOLIDAY OIL|SHELL OIL|COSTCO GAS|TESLA SUPERCHARGER', 'regex', 'out', 'delivery', 50, 'Route fuel; override if personal', datetime('now'));
