// POST /api/admin/delivery-status — advance the delivery lifecycle for a week's LOCKED orders and
// notify the customers. Admin-gated (ops/driver action; can also be wired to a driver app later).
//   ?status=prepping|out_for_delivery|delivered|pickup_ready|picked_up   (required)
//   ?week_of=YYYY-MM-DD   (default: the upcoming Sunday)
//   ?sub_id=...           (optional: target one subscription's order)
// out_for_delivery/delivered only touch DELIVERY customers; pickup_ready/picked_up only PICKUP;
// prepping applies to both. Notifications are deduped per (status, order) so a re-run is safe.
import { ok, fail } from '../../_lib/respond.js';
import { requireAdmin } from '../../_lib/admin.js';
import { all, run, nowIso } from '../../_lib/db.js';
import { upcomingSunday } from '../../_lib/menu.js';
import { randomToken } from '../../_lib/crypto.js';
import { notify } from '../../_lib/notify.js';

const VALID = new Set(['prepping', 'out_for_delivery', 'delivered', 'pickup_ready', 'picked_up']);
const METHOD = { out_for_delivery: 'delivery', delivered: 'delivery', pickup_ready: 'pickup', picked_up: 'pickup' };
const EVENT = { prepping: 'order_prepped', out_for_delivery: 'order_out_for_delivery', delivered: 'order_delivered', pickup_ready: 'order_pickup_ready' };
// 'picked_up' intentionally has NO event (telling someone they picked up their own food is pointless).
// Forward-only rank: a status may only advance, never regress (prevents a fat-fingered re-mark from
// re-firing "on the way" for an already-delivered order).
const RANK = { scheduled: 0, prepping: 1, out_for_delivery: 2, pickup_ready: 2, delivered: 3, picked_up: 3 };

export async function onRequestPost(context) {
  const { request, env } = context;
  const denied = await requireAdmin(context);
  if (denied) return denied;

  const u = new URL(request.url);
  const weekOf = u.searchParams.get('week_of') || upcomingSunday();
  const status = u.searchParams.get('status') || '';
  const subId = u.searchParams.get('sub_id') || '';
  const eta = u.searchParams.get('eta') || null; // optional ETA shown on the tracker + in the email
  if (!VALID.has(status)) return fail(400, 'bad_status', `status must be one of: ${[...VALID].join(', ')}`);
  // Reject an arbitrary/garbage week so a bad client value can't mass-advance the wrong week's orders.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekOf) || new Date(`${weekOf}T12:00:00Z`).getUTCDay() !== 0) {
    return fail(400, 'bad_week', 'week_of must be a Sunday (YYYY-MM-DD).');
  }

  const wantMethod = METHOD[status]; // undefined for 'prepping' → applies to both
  // FROZEN method (snapshot at lock); fall back to the live method for any pre-snapshot order.
  const rows = await all(env.DB,
    `SELECT o.id AS order_id, o.subscription_id, o.total_meals, o.tracking_token, o.delivery_status,
            COALESCE(o.delivery_method, c.delivery_method) AS method,
            c.id AS customer_id, c.email, c.first_name, c.ghl_contact_id
       FROM orders o JOIN customers c ON c.id = o.customer_id
      WHERE o.week_of = ? AND o.status = 'locked'` + (subId ? ` AND o.subscription_id = ?` : ``),
    ...(subId ? [weekOf, subId] : [weekOf]));

  const now = nowIso();
  const base = env.APP_BASE_URL || 'https://gainztrainprep.com';
  const summary = { week_of: weekOf, status, targeted: 0, updated: 0, notified: 0, skipped: 0 };

  for (const r of rows) {
    if (wantMethod && r.method !== wantMethod) { summary.skipped++; continue; }
    // Forward-only: never regress, and don't re-apply the same state (idempotent re-runs are a no-op).
    if ((RANK[status] ?? 0) <= (RANK[r.delivery_status || 'scheduled'] ?? 0)) { summary.skipped++; continue; }
    summary.targeted++;
    const trackingToken = r.tracking_token || randomToken(32);
    const delivered = (status === 'delivered' || status === 'picked_up') ? now : null;
    await run(env.DB,
      `UPDATE orders SET delivery_status=?, tracking_token=COALESCE(tracking_token,?),
         delivery_eta=COALESCE(?, delivery_eta), delivered_at=COALESCE(delivered_at, ?), updated_at=? WHERE id=?`,
      status, trackingToken, eta, delivered, now, r.order_id);
    summary.updated++;

    const ev = EVENT[status];
    if (ev) {
      const trackUrl = r.method === 'delivery' ? `${base}/app/track/?t=${trackingToken}` : null;
      const cust = { id: r.customer_id, email: r.email, first_name: r.first_name, ghl_contact_id: r.ghl_contact_id };
      const res = await notify(env, cust, ev, { weekOf, method: r.method, trackUrl, eta }, { dedupKey: `delivery:${status}:${r.order_id}` });
      if (res.ok && !res.deduped) summary.notified++;
    }
  }
  return ok({ summary });
}
