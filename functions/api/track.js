// GET /api/track?t=<tracking_token> — public delivery status behind an opaque token (the token IS the
// capability; no login). Returns minimal, non-PII status for the public tracker page.
import { ok, fail } from '../_lib/respond.js';
import { one } from '../_lib/db.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const t = (new URL(request.url).searchParams.get('t') || '').trim();
  if (!t) return fail(400, 'missing_token', 'Missing tracking token.');

  // NON-PII only: this is a login-less, forwardable surface. No name/email/address/phone/amounts.
  // Method uses the FROZEN order method (snapshot at lock) so a post-lock customer switch can't
  // mis-render the flow; falls back to the customer's current method for pre-snapshot orders.
  const o = await one(env.DB,
    `SELECT o.week_of, o.total_meals, o.delivery_status, o.delivery_eta, o.delivered_at,
            COALESCE(o.delivery_method, c.delivery_method) AS method
       FROM orders o JOIN customers c ON c.id = o.customer_id
      WHERE o.tracking_token = ?`, t);
  if (!o) return fail(404, 'not_found', "We couldn't find that order.");

  return ok({
    order: {
      week_of: o.week_of,
      total_meals: o.total_meals,
      method: o.method,
      status: o.delivery_status || 'scheduled',
      eta: o.delivery_eta || null,
      delivered_at: o.delivered_at || null,
    },
  });
}
