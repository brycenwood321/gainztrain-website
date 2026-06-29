// Helpers for the self-service account endpoints. All operate on the LOGGED-IN customer's own
// subscription (looked up by their session customer.id — never a body-supplied id).
import { one } from './db.js';

// The customer's current manageable subscription (most recent non-canceled). Returns the D1 row
// (incl. stripe_subscription_id + status) or null.
export async function currentSub(env, customerId, statuses) {
  const list = statuses && statuses.length ? statuses : ['active', 'trialing', 'past_due', 'paused', 'incomplete'];
  // Deterministic tiebreak (id DESC) so selection is stable when created_at collides.
  return one(env.DB,
    `SELECT * FROM subscriptions WHERE customer_id = ? AND status IN (${list.map(() => '?').join(',')})
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    customerId, ...list);
}

// Find a Stripe subscription line item whose price's lookup_key starts with a prefix
// (e.g. 'gt_meal' for the meal line, 'gt_delivery_zone' for the delivery line).
export function findItem(stripeSub, keyPrefix) {
  return (stripeSub?.items?.data || []).find((it) => (it.price?.lookup_key || '').startsWith(keyPrefix)) || null;
}

// Find the MEAL line item, tolerant of legacy/hand-built subs. New app subs price the meal line
// with a lookup_key starting 'gt_meal'; legacy subs (e.g. Jayson's family comps) may carry a flat
// weekly meal line with no such key. Fall back to "the non-delivery line with the largest weekly
// total" (the meal line always dwarfs a delivery add-on), so self-service tier changes work for
// migrated customers too — the change rewrites that line onto the proper per-meal price.
export function findMealItem(stripeSub) {
  const items = stripeSub?.items?.data || [];
  const tagged = items.find((it) => (it.price?.lookup_key || '').startsWith('gt_meal'));
  if (tagged) return tagged;
  const nonDelivery = items.filter((it) => !(it.price?.lookup_key || '').startsWith('gt_delivery_zone'));
  const pool = nonDelivery.length ? nonDelivery : items;
  const lineTotal = (it) => (it.price?.unit_amount || 0) * (it.quantity || 1);
  return pool.slice().sort((a, b) => lineTotal(b) - lineTotal(a))[0] || null;
}
