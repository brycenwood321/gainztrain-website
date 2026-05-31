-- Repair: 0003's `ALTER TABLE subscriptions RENAME` rewrote the FK references in the
-- child tables (invoices/orders/meal_selections) to point at the temp table
-- `_subscriptions_old`, which was then dropped — leaving dangling references that break
-- all writes to those tables. Rebuild the three child tables with correct FK references
-- back to subscriptions(id).
--
-- KEY: legacy_alter_table = ON so these RENAMEs do NOT rewrite OTHER tables' references
-- (e.g. payments → invoices stays intact). This is the safe table-rebuild pattern.
PRAGMA legacy_alter_table = ON;
PRAGMA defer_foreign_keys = TRUE;

-- ── invoices ──
ALTER TABLE invoices RENAME TO _invoices_old;
CREATE TABLE invoices (
  id                  TEXT PRIMARY KEY,
  customer_id         TEXT REFERENCES customers(id),
  subscription_id     TEXT REFERENCES subscriptions(id),
  status              TEXT,
  amount_due_cents    INTEGER,
  amount_paid_cents   INTEGER,
  subtotal_cents      INTEGER,
  discount_cents      INTEGER,
  period_start        TEXT,
  period_end          TEXT,
  hosted_invoice_url  TEXT,
  created_at          TEXT NOT NULL
);
INSERT INTO invoices SELECT * FROM _invoices_old;
DROP TABLE _invoices_old;
CREATE INDEX idx_invoices_customer ON invoices(customer_id);

-- ── orders ──
ALTER TABLE orders RENAME TO _orders_old;
CREATE TABLE orders (
  id                    TEXT PRIMARY KEY,
  subscription_id       TEXT NOT NULL REFERENCES subscriptions(id),
  customer_id           TEXT NOT NULL REFERENCES customers(id),
  week_of               TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','locked','prepped','skipped_paused','skipped_canceled')),
  total_meals           INTEGER NOT NULL DEFAULT 0,
  upcharge_total_cents  INTEGER NOT NULL DEFAULT 0,
  delivery_fee_cents    INTEGER NOT NULL DEFAULT 0,
  locked_at             TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (subscription_id, week_of)
);
INSERT INTO orders SELECT * FROM _orders_old;
DROP TABLE _orders_old;
CREATE INDEX idx_orders_week ON orders(week_of);
CREATE INDEX idx_orders_customer ON orders(customer_id);

-- ── meal_selections ──
ALTER TABLE meal_selections RENAME TO _meal_selections_old;
CREATE TABLE meal_selections (
  id                      TEXT PRIMARY KEY,
  subscription_id         TEXT NOT NULL REFERENCES subscriptions(id),
  week_of                 TEXT NOT NULL,
  meal_position           INTEGER NOT NULL CHECK (meal_position BETWEEN 1 AND 8),
  meal_name               TEXT NOT NULL,
  qty                     INTEGER NOT NULL DEFAULT 0,
  upcharge_per_meal_cents INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  UNIQUE (subscription_id, week_of, meal_position)
);
INSERT INTO meal_selections SELECT * FROM _meal_selections_old;
DROP TABLE _meal_selections_old;
CREATE INDEX idx_sel_week ON meal_selections(week_of);
