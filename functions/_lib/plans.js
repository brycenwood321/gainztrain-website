// Gainz Train subscription plans. Single source of truth for tiers + the Stripe price wiring.
// Pricing: per-meal rate by volume, 6–16 meals/week (mirrors the live subscribe/ page).
// The app sells `price-per-meal × quantity(= meal count)` so the Stripe subscription's line
// quantity IS the meal count, and we also stamp metadata.meals_per_week — both feed the webhook.
import { stripe } from './stripe.js';

export const MIN_MEALS = 6;
export const MAX_MEALS = 16;

export const TIERS = [
  { key: 'starter', name: 'Starter', min: 6,  max: 9,  perMealCents: 1050, lookupKey: 'gt_meal_1050' },
  { key: 'athlete', name: 'Athlete', min: 10, max: 13, perMealCents: 950,  lookupKey: 'gt_meal_0950' },
  { key: 'elite',   name: 'Elite',   min: 14, max: 16, perMealCents: 850,  lookupKey: 'gt_meal_0850' },
];

// The tier whose meal-range contains n, or null if n is out of range.
export function tierForMeals(n) {
  if (!Number.isInteger(n)) return null;
  return TIERS.find((t) => n >= t.min && n <= t.max) || null;
}

// Public plan list for the pick-a-plan page (no Stripe ids leaked).
export function publicPlans() {
  return TIERS.map((t) => ({ key: t.key, name: t.name, min: t.min, max: t.max, per_meal_cents: t.perMealCents }));
}

// Find-or-create a named Stripe Product (idempotent: name lookup + idempotency key on create).
async function ensureProduct(env, name) {
  const list = await stripe(env, 'GET', 'products', { active: true, limit: 100 });
  const found = (list.data || []).find((p) => p.name === name);
  if (found) return found.id;
  const created = await stripe(env, 'POST', 'products', { name }, `gt_prod_${name.replace(/\s+/g, '_')}`);
  return created.id;
}

// Find-or-create a recurring WEEKLY Stripe Price. The lookup_key ENCODES the amount
// (`${keyBase}_${unitAmount}`) so a price found by key always has the right amount — a rate change
// produces a NEW key/price and can never silently serve a stale price. We also assert the amount
// as a belt-and-suspenders, and pass an idempotency key so a find-or-create race can't duplicate.
// FUTURE (weekly-vs-monthly): add an `interval` arg and fold it into keyBase.
async function ensurePrice(env, { productName, keyBase, unitAmount, nickname }) {
  const lookupKey = `${keyBase}_${unitAmount}`;
  const existing = await stripe(env, 'GET', 'prices', { lookup_keys: [lookupKey], active: true, limit: 1 });
  if (existing.data && existing.data.length && existing.data[0].unit_amount === unitAmount) {
    return existing.data[0].id;
  }
  const productId = await ensureProduct(env, productName);
  const price = await stripe(env, 'POST', 'prices', {
    product: productId,
    currency: 'usd',
    unit_amount: unitAmount,
    recurring: { interval: 'week' },
    lookup_key: lookupKey,
    transfer_lookup_key: true, // move the key onto the new price if an old one held it
    nickname,
  }, `gt_price_${lookupKey}`);
  return price.id;
}

export async function ensureStripePrice(env, tier) {
  return ensurePrice(env, {
    productName: 'Gainz Train Meals',
    keyBase: 'gt_meal',
    unitAmount: tier.perMealCents,
    nickname: `${tier.name} — $${(tier.perMealCents / 100).toFixed(2)}/meal`,
  });
}

// Delivery fee as its own recurring weekly line item. feeCents comes from the delivery_zones table.
export async function ensureDeliveryPrice(env, zone, feeCents) {
  return ensurePrice(env, {
    productName: 'Gainz Train Delivery',
    keyBase: `gt_delivery_zone_${zone}`,
    unitAmount: feeCents,
    nickname: `Delivery — Zone ${zone}`,
  });
}
