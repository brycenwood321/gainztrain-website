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

// Weekly LIST value (pre-discount) of a set of subscription rows, in cents.
//
// ⚠️ Do NOT compute this as SUM(meals_per_week * tier_price_cents) in SQL, which is what the owner
// digest and the ops Overview both did until 2026-08-12. `tier_price_cents` is NULL for almost every
// subscription: _lib/mirror.js `deriveMealTier` returns `unit: null` whenever the Stripe subscription
// carries `metadata.meals_per_week` — which every app checkout does — so the column is only ever
// written as a side effect of a tier CHANGE. Live at the time of the fix: 8 of 9 active subs NULL, so
// the digest Brycen reads every morning reported $73.50/week against a real figure near $650.
//
// The plan bands are the authority; the mirrored column is only a fallback for a legacy/custom price
// that does not fit a band. Same derivation the customer-facing display already uses in api/me.js.
export function weeklyListCents(rows) {
  return (rows || []).reduce((sum, r) => {
    const meals = Number(r.meals_per_week) || 0;
    if (!meals) return sum;
    const perMeal = tierForMeals(meals)?.perMealCents ?? Number(r.tier_price_cents) ?? 0;
    return sum + meals * perMeal;
  }, 0);
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

// FUEL8 flyer promo: 2 free meals/week for the first 4 weeks, sized to the customer's tier. Delivered as
// a per-tier Stripe coupon (amount_off = 2 x that tier's per-meal price). duration=repeating/1-month is a
// HARD CEILING (Stripe caps a weekly sub to ~4-5 discounted invoices); the webhook trims it to exactly 4
// weekly applications, so the worst case if that trim ever misfired is ~5 weeks, never a runaway discount.
// Idempotent by coupon id (FUEL8_STARTER / FUEL8_ATHLETE / FUEL8_ELITE).
export async function ensureFuel8Coupon(env, tier) {
  const id = `FUEL8_${tier.key.toUpperCase()}`;
  const amountOff = 2 * tier.perMealCents; // 2 meals at this tier
  try {
    const existing = await stripe(env, 'GET', `coupons/${id}`);
    if (existing && existing.id) return existing.id;
  } catch { /* not found -> create below */ }
  try {
    const c = await stripe(env, 'POST', 'coupons', {
      id, name: `FUEL8 - 2 free ${tier.name} meals/wk`,
      amount_off: amountOff, currency: 'usd',
      duration: 'repeating', duration_in_months: 1,
    }, `gt_fuel8_${id}`);
    return c.id;
  } catch (e) {
    if (e?.stripe?.code === 'resource_already_exists') return id;
    throw e;
  }
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
