-- 0018_owner_flag.sql
-- Owner vs Staff on the unified ops dashboard. The role CHECK constraint only allows 'customer'/'staff',
-- so owners stay role='staff' and are distinguished by is_owner=1. Owners (Brycen/Jayson/Marissa/Alyssa)
-- see all tabs; plain staff (kitchen hires) see only Orders/Assembly/Pickup/Delivery/Ingredients.
-- Enforced server-side via requireOwner() on owner-only endpoints.
ALTER TABLE customers ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0;
