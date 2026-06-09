-- 0012: repair the payments.invoice_id foreign key. A past invoices-table rebuild left it pointing at
-- a phantom "_invoices_old" table (migration 0004 repaired the other child FKs but missed payments), so
-- EVERY payment insert 500'd on the FK check — which is why payment_intent.succeeded events failed and
-- the payments table is empty. SQLite can't alter a column's FK in place, so recreate the table with the
-- correct reference. Table is empty, so the copy is a no-op and this is risk-free.
CREATE TABLE payments_new (
  id            TEXT PRIMARY KEY,
  invoice_id    TEXT REFERENCES invoices(id),
  customer_id   TEXT REFERENCES customers(id),
  amount_cents  INTEGER,
  status        TEXT,
  created_at    TEXT NOT NULL
);
INSERT INTO payments_new (id, invoice_id, customer_id, amount_cents, status, created_at)
  SELECT id, invoice_id, customer_id, amount_cents, status, created_at FROM payments;
DROP TABLE payments;
ALTER TABLE payments_new RENAME TO payments;
CREATE INDEX idx_payments_customer ON payments(customer_id);
