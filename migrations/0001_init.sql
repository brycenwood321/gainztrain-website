-- Gainz Train — single source of truth schema (D1 / SQLite).
-- Money is stored in integer CENTS. Timestamps are ISO-8601 UTC text (sorts correctly).
-- Annotations in comments: [OURS]=we own it, [STRIPE]=mirrored from Stripe webhooks, [GHL]=comms join key.

-- ─────────────────────────────────────────────────────────────────────────────
-- customers — the one row that is the truth about a person.
-- role gates the ops/admin view (staff = Brycen, Marissa, Jayson, Alyssa).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE customers (
  id                  TEXT PRIMARY KEY,            -- [OURS] our uuid, stable forever
  email               TEXT NOT NULL UNIQUE,        -- [OURS] lowercased login identity
  first_name          TEXT,
  last_name           TEXT,
  phone               TEXT,                        -- [OURS] E.164
  role                TEXT NOT NULL DEFAULT 'customer'  -- 'customer' | 'staff'
                        CHECK (role IN ('customer','staff')),
  goal                TEXT                         -- 'cut' | 'maintain' | 'build' | NULL
                        CHECK (goal IS NULL OR goal IN ('cut','maintain','build')),
  stripe_customer_id  TEXT UNIQUE,                 -- [STRIPE] cus_...
  ghl_contact_id      TEXT,                        -- [GHL] join key for comms only
  zip                 TEXT,                        -- [OURS] drives delivery zone
  delivery_zone       INTEGER,                     -- [OURS] 0=pickup, 1-4
  delivery_method     TEXT DEFAULT 'pickup'        -- 'pickup' | 'delivery'
                        CHECK (delivery_method IN ('pickup','delivery')),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_customers_stripe ON customers(stripe_customer_id);
CREATE INDEX idx_customers_ghl    ON customers(ghl_contact_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- subscriptions — status is the ATOMIC pause flag both billing + prep read.
-- discount_active is the Alyssa referee: kept in lockstep with Stripe's real discount.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE subscriptions (
  id                      TEXT PRIMARY KEY,        -- [OURS] uuid
  customer_id             TEXT NOT NULL REFERENCES customers(id),
  stripe_subscription_id  TEXT UNIQUE,             -- [STRIPE] sub_...
  status                  TEXT NOT NULL DEFAULT 'incomplete'  -- [STRIPE]+[OURS]
                            CHECK (status IN ('active','paused','canceled','past_due','incomplete')),
  meals_per_week          INTEGER NOT NULL,        -- [OURS] paid tier: 5/10/15/20 (validates selections)
  tier_price_cents        INTEGER,                 -- [STRIPE] base meal item price
  current_period_start    TEXT,                    -- [STRIPE]
  current_period_end      TEXT,                    -- [STRIPE]
  cancel_at_period_end    INTEGER NOT NULL DEFAULT 0,  -- [STRIPE] bool
  paused_at               TEXT,                    -- [OURS] when we paused (audit)
  coupon_code             TEXT,                    -- [OURS] OWNERS100 / FAMFRIENDS15 / FOUNDER25
  discount_active         INTEGER NOT NULL DEFAULT 0,  -- [STRIPE] is the discount REALLY attached
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE INDEX idx_subs_customer ON subscriptions(customer_id);
CREATE INDEX idx_subs_status   ON subscriptions(status);

-- ─────────────────────────────────────────────────────────────────────────────
-- meal_selections — one row per (subscription, week, meal position 1-4).
-- upcharge snapshot at selection time so historical orders never re-price.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE meal_selections (
  id                      TEXT PRIMARY KEY,
  subscription_id         TEXT NOT NULL REFERENCES subscriptions(id),
  week_of                 TEXT NOT NULL,           -- matches menus.json week_of (a Sunday)
  meal_position           INTEGER NOT NULL CHECK (meal_position BETWEEN 1 AND 8),
  meal_name               TEXT NOT NULL,
  qty                     INTEGER NOT NULL DEFAULT 0,
  upcharge_per_meal_cents INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  UNIQUE (subscription_id, week_of, meal_position)
);
CREATE INDEX idx_sel_week ON meal_selections(week_of);

-- ─────────────────────────────────────────────────────────────────────────────
-- orders — the cookable order for a (subscription, week). Prep list reads this;
-- pause suppresses it (status skipped_paused).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE orders (
  id                    TEXT PRIMARY KEY,
  subscription_id       TEXT NOT NULL REFERENCES subscriptions(id),
  customer_id           TEXT NOT NULL REFERENCES customers(id),  -- denormalized for fast ops query
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
CREATE INDEX idx_orders_week ON orders(week_of);
CREATE INDEX idx_orders_customer ON orders(customer_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- weekly_menus — mirror of menus.json so the scheduler/ops view don't depend on a fetch.
-- menus.json stays the hand-edit source; a publish step syncs it in.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE weekly_menus (
  week_of       TEXT PRIMARY KEY,
  label         TEXT,
  meals_json    TEXT NOT NULL,        -- the 4-meal array verbatim
  published_at  TEXT,                 -- NULL until publish fires
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────────
-- invoices + payments — Stripe-mirrored money history (the spend view).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE invoices (
  id                  TEXT PRIMARY KEY,            -- [STRIPE] in_...
  customer_id         TEXT REFERENCES customers(id),
  subscription_id     TEXT REFERENCES subscriptions(id),
  status              TEXT,                        -- draft|open|paid|uncollectible|void
  amount_due_cents    INTEGER,
  amount_paid_cents   INTEGER,
  subtotal_cents      INTEGER,
  discount_cents      INTEGER,
  period_start        TEXT,
  period_end          TEXT,
  hosted_invoice_url  TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_invoices_customer ON invoices(customer_id);

CREATE TABLE payments (
  id            TEXT PRIMARY KEY,                  -- [STRIPE] pi_.../ch_...
  invoice_id    TEXT REFERENCES invoices(id),
  customer_id   TEXT REFERENCES customers(id),
  amount_cents  INTEGER,
  status        TEXT,                              -- succeeded|failed|refunded
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_payments_customer ON payments(customer_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Reference tables: delivery zones, zip→zone map, coupons.
-- stripe_price_id / stripe_coupon_id replace fragile runtime product-name regex scans.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE delivery_zones (
  zone            INTEGER PRIMARY KEY,             -- 0-4
  name            TEXT NOT NULL,
  fee_cents       INTEGER NOT NULL,
  stripe_price_id TEXT
);

CREATE TABLE zip_zone_map (
  zip   TEXT PRIMARY KEY,
  zone  INTEGER NOT NULL REFERENCES delivery_zones(zone)
);

CREATE TABLE coupons (
  code             TEXT PRIMARY KEY,               -- OWNERS100 ...
  stripe_coupon_id TEXT,
  percent_off      INTEGER,
  duration         TEXT,                           -- 'forever' | 'once'
  cap              INTEGER,
  expires_at       TEXT,
  times_redeemed   INTEGER NOT NULL DEFAULT 0
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Auth: passwords, single-use tokens (magic-link + SMS OTP), sessions.
-- Secrets are stored HASHED, never raw. Sessions are opaque + D1-backed = revocable.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE auth_passwords (
  customer_id    TEXT PRIMARY KEY REFERENCES customers(id),
  password_hash  TEXT NOT NULL,        -- PBKDF2-SHA256 derived bits (hex)
  salt           TEXT NOT NULL,        -- hex
  iterations     INTEGER NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE auth_tokens (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  kind         TEXT NOT NULL CHECK (kind IN ('magic_link','sms_otp')),
  token_hash   TEXT NOT NULL,          -- SHA-256 of the raw secret/code
  expires_at   TEXT NOT NULL,          -- magic_link ~15min, sms_otp ~10min
  consumed_at  TEXT,                   -- single-use enforcement
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_ip   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_authtok_customer ON auth_tokens(customer_id, kind);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,      -- random 256-bit opaque id (stored as-is; cookie carries HMAC)
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL,         -- sliding 30 days
  user_agent    TEXT,
  ip            TEXT,
  revoked_at    TEXT
);
CREATE INDEX idx_sessions_customer ON sessions(customer_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- stripe_events — idempotency ledger. Insert-before-process; UNIQUE blocks double-apply
-- on webhook retries. This is the backbone of "D1 and Stripe can never silently disagree."
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE stripe_events (
  event_id      TEXT PRIMARY KEY,      -- evt_...
  type          TEXT,
  received_at   TEXT NOT NULL,
  processed_at  TEXT
);

-- ─────────────────────────────────────────────────────────────────────────────
-- audit_log — every state change. actor + plain-English before/after ("show your math").
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  actor        TEXT,                   -- customer:<id> | cron:<job> | webhook:stripe | admin:<id>
  entity       TEXT,                   -- subscription:<id> ...
  action       TEXT,                   -- pause|resume|meal_select|upcharge_billed|zone_assigned ...
  detail_json  TEXT
);
CREATE INDEX idx_audit_entity ON audit_log(entity);

-- ─────────────────────────────────────────────────────────────────────────────
-- comms_log — every email/SMS sent via GHL (for the watchdog's failed/stuck check).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE comms_log (
  id          TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES customers(id),
  contact_id  TEXT,                    -- GHL contact id
  channel     TEXT,                    -- email | sms
  template    TEXT,                    -- payment_failed | magic_link | pause_confirm ...
  body        TEXT,
  ghl_status  TEXT,                    -- sent | failed | queued
  sent_at     TEXT NOT NULL
);
CREATE INDEX idx_comms_customer ON comms_log(customer_id);
