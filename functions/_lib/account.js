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
