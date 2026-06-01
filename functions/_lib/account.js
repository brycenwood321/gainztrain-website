// Helpers for the self-service account endpoints. All operate on the LOGGED-IN customer's own
// subscription (looked up by their session customer.id — never a body-supplied id).
import { one } from './db.js';

// The customer's current manageable subscription (most recent non-canceled). Returns the D1 row
// (incl. stripe_subscription_id + status) or null.
export async function currentSub(env, customerId, statuses) {
  const list = statuses && statuses.length ? statuses : ['active', 'trialing', 'past_due', 'paused', 'incomplete'];
  return one(env.DB,
    `SELECT * FROM subscriptions WHERE customer_id = ? AND status IN (${list.map(() => '?').join(',')})
     ORDER BY created_at DESC LIMIT 1`,
    customerId, ...list);
}
