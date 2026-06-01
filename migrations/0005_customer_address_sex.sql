-- Phase 1: delivery needs the customer's street address; macros (Phase 2) need sex.
-- Additive nullable columns — safe ALTER ADD COLUMN, no table rebuild, no data impact.
-- (zip + delivery_zone + delivery_method already exist from 0001.)
ALTER TABLE customers ADD COLUMN address TEXT;     -- street address for delivery routing
ALTER TABLE customers ADD COLUMN city    TEXT;
ALTER TABLE customers ADD COLUMN sex     TEXT;      -- 'male' | 'female' (validated in app); drives goal-based macro portions
