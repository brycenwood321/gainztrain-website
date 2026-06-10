// /api/admin/delivery-status — advance the delivery lifecycle for orders and notify the customers.
// Admin-gated (ops/driver/scan action).
//
// POST modes:
//   • Mass (existing): ?status=prepping|out_for_delivery|delivered|pickup_ready|picked_up [&week_of=][&sub_id=]
//     advances every matching LOCKED order for the week (out_for_delivery/delivered = delivery only;
//     pickup_ready/picked_up = pickup only; prepping = both).
//   • Single (QR scan): ?order_id=<id>&status=next  (or an explicit status) advances ONE order one step.
// GET ?order_id=<id> → that order's current status + customer + the computed next step (powers the scan page).
//
// Forward-only: a status may only advance, never regress. Notifications are deduped per (status, order).
import { ok, fail } from '../../_lib/respond.js';
import { requireAdmin } from '../../_lib/admin.js';
import { all, one, run, nowIso } from '../../_lib/db.js';
import { upcomingSunday } from '../../_lib/menu.js';
import { randomToken } from '../../_lib/crypto.js';
import { notify } from '../../_lib/notify.js';

const VALID = new Set(['prepping', 'out_for_delivery', 'delivered', 'pickup_ready', 'picked_up']);
const METHOD = { out_for_delivery: 'delivery', delivered: 'delivery', pickup_ready: 'pickup', picked_up: 'pickup' };
const EVENT = { prepping: 'order_prepped', out_for_delivery: 'order_out_for_delivery', delivered: 'order_delivered', pickup_ready: 'order_pickup_ready' };
const RANK = { scheduled: 0, prepping: 1, out_for_delivery: 2, pickup_ready: 2, delivered: 3, picked_up: 3 };
const SEQ = { delivery: ['scheduled', 'prepping', 'out_for_delivery', 'delivered'], pickup: ['scheduled', 'prepping', 'pickup_ready', 'picked_up'] };

function nextStatus(method, cur) {
  const seq = SEQ[method === 'delivery' ? 'delivery' : 'pickup'];
  const i = seq.indexOf(cur || 'scheduled');
  return i >= 0 && i < seq.length - 1 ? seq[i + 1] : null;
}

// GET — read one order (by order_id) for the scan page: current status + who + the next step.
export async function onRequestGet(context) {
  const denied = await requireAdmin(context);
  if (denied) return denied;
  const orderId = new URL(context.request.url).searchParams.get('order_id') || '';
  if (!orderId) return fail(400, 'order_id_required', 'order_id is required.');
  const r = await one(context.env.DB,
    `SELECT o.id AS order_id, o.week_of, o.total_meals, o.delivery_status,
            COALESCE(o.delivery_method, c.delivery_method) AS method,
            c.first_name, c.last_name, c.address, c.city, c.zip
       FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`, orderId);
  if (!r) return fail(404, 'not_found', 'No order with that code.');
  const cur = r.delivery_status || 'scheduled';
  return ok({ order: { ...r, delivery_status: cur, next: nextStatus(r.method, cur) } });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const denied = await requireAdmin(context);
  if (denied) return denied;

  const u = new URL(request.url);
  const orderId = u.searchParams.get('order_id') || '';
  let status = u.searchParams.get('status') || '';
  const subId = u.searchParams.get('sub_id') || '';
  const eta = u.searchParams.get('eta') || null;

  // ── Single-order mode (QR scan) ──
  if (orderId) {
    const r = await one(env.DB,
      `SELECT o.id AS order_id, o.week_of, o.tracking_token, o.delivery_status,
              COALESCE(o.delivery_method, c.delivery_method) AS method,
              c.id AS customer_id, c.email, c.first_name, c.ghl_contact_id
         FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`, orderId);
    if (!r) return fail(404, 'not_found', 'No order with that code.');
    if (status === 'next' || !status) status = nextStatus(r.method, r.delivery_status || 'scheduled');
    if (!status) return ok({ summary: { updated: 0, notified: 0, done: true }, status: r.delivery_status });
    if (!VALID.has(status)) return fail(400, 'bad_status', 'Invalid status.');
    if ((RANK[status] ?? 0) <= (RANK[r.delivery_status || 'scheduled'] ?? 0)) {
      return ok({ summary: { updated: 0, notified: 0 }, status: r.delivery_status, note: 'already at or past that step' });
    }
    const now = nowIso();
    const trackingToken = r.tracking_token || randomToken(32);
    const delivered = (status === 'delivered' || status === 'picked_up') ? now : null;
    await run(env.DB,
      `UPDATE orders SET delivery_status=?, tracking_token=COALESCE(tracking_token,?),
         delivery_eta=COALESCE(?, delivery_eta), delivered_at=COALESCE(delivered_at, ?), updated_at=? WHERE id=?`,
      status, trackingToken, eta, delivered, now, r.order_id);
    let notified = 0;
    const ev = EVENT[status];
    if (ev) {
      const base = env.APP_BASE_URL || 'https://gainztrainprep.com';
      const trackUrl = r.method === 'delivery' ? `${base}/app/track/?t=${trackingToken}` : null;
      const cust = { id: r.customer_id, email: r.email, first_name: r.first_name, ghl_contact_id: r.ghl_contact_id };
      const res = await notify(env, cust, ev, { weekOf: r.week_of, method: r.method, trackUrl, eta }, { dedupKey: `delivery:${status}:${r.order_id}` });
      if (res.ok && !res.deduped) notified = 1;
    }
    return ok({ summary: { updated: 1, notified }, status, next: nextStatus(r.method, status) });
  }

  // ── Mass mode (week run sheet) ──
  const weekOf = u.searchParams.get('week_of') || upcomingSunday();
  if (!VALID.has(status)) return fail(400, 'bad_status', `status must be one of: ${[...VALID].join(', ')}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekOf) || new Date(`${weekOf}T12:00:00Z`).getUTCDay() !== 0) {
    return fail(400, 'bad_week', 'week_of must be a Sunday (YYYY-MM-DD).');
  }

  const wantMethod = METHOD[status];
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
