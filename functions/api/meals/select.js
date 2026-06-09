// POST /api/meals/select — save the customer's meal picks for the orderable week.
// Body: { week_of, selections: [{ position, qty }] }. Session-gated.
// Rules: must have a live subscription; the picks must total exactly meals_per_week; the week must
// be the current orderable week and not past the Friday cutoff; positions must exist on the menu.
// Writes meal_selections (qty + upcharge snapshot) + upserts the week's order.
import { ok, fail, readJson } from '../../_lib/respond.js';
import { one, run, nowIso } from '../../_lib/db.js';
import { getSessionCustomer } from '../../_lib/auth.js';
import { orderableWeek, isLocked } from '../../_lib/menu.js';
import { notify } from '../../_lib/notify.js';

export async function onRequestPost(context) {
  const auth = await getSessionCustomer(context);
  if (!auth) return fail(401, 'not_authenticated', 'Please log in.');
  const { request, env } = context;
  const { customer } = auth;

  const body = await readJson(request);
  const weekOf = typeof body.week_of === 'string' ? body.week_of : '';
  const rawSel = Array.isArray(body.selections) ? body.selections : [];

  // Must be the current orderable week + still open.
  if (weekOf !== orderableWeek()) return fail(409, 'wrong_week', 'That ordering week has changed — refresh and try again.');
  if (isLocked(weekOf)) return fail(409, 'ordering_locked', "Ordering for this week has closed (Friday cutoff).");

  const sub = await one(env.DB,
    `SELECT id, meals_per_week, status FROM subscriptions
     WHERE customer_id = ? AND status IN ('active','trialing','past_due','paused') ORDER BY created_at DESC, id DESC LIMIT 1`,
    customer.id);
  if (!sub) return fail(400, 'no_subscription', 'You need an active plan to order meals.');
  if (sub.status === 'paused') return fail(409, 'plan_paused', 'Your plan is paused — resume it to order meals.');
  if (!(sub.meals_per_week > 0)) return fail(409, 'tier_unset', "Your plan's meal count isn't set yet — contact us.");

  const menuRow = await one(env.DB, `SELECT meals_json FROM weekly_menus WHERE week_of = ?`, weekOf);
  if (!menuRow) return fail(404, 'no_menu', 'No menu is published for this week yet.');
  const menu = JSON.parse(menuRow.meals_json);
  if (!Array.isArray(menu) || menu.length === 0) return fail(404, 'no_menu', 'No menu is published for this week yet.');
  const byPos = new Map(menu.map((m) => [m.position, m]));

  // Don't let a late save overwrite an order that lock-week already locked (cutoff TOCTOU race).
  const existingOrder = await one(env.DB, `SELECT status FROM orders WHERE subscription_id = ? AND week_of = ?`, sub.id, weekOf);
  if (existingOrder && existingOrder.status === 'locked') return fail(409, 'ordering_locked', 'Ordering for this week has closed.');

  // Normalize + validate submitted quantities.
  const qtyByPos = new Map();
  for (const s of rawSel) {
    const pos = Number(s.position), qty = Number(s.qty);
    if (!Number.isInteger(pos) || !byPos.has(pos)) return fail(400, 'invalid_position', 'One of the meals is no longer on the menu.');
    if (!Number.isInteger(qty) || qty < 0 || qty > 50) return fail(400, 'invalid_qty', 'Invalid meal quantity.');
    qtyByPos.set(pos, (qtyByPos.get(pos) || 0) + qty);
  }
  const total = [...qtyByPos.values()].reduce((a, b) => a + b, 0);
  if (total !== sub.meals_per_week) {
    return fail(400, 'wrong_total', `Pick exactly ${sub.meals_per_week} meals (you picked ${total}).`);
  }

  const now = nowIso();
  let upchargeTotal = 0;
  // Clear any prior rows for this week first (drops positions from an old menu), then write fresh.
  await run(env.DB, `DELETE FROM meal_selections WHERE subscription_id = ? AND week_of = ?`, sub.id, weekOf);
  // Upsert one row per menu position (qty 0 for unpicked) so the week's picks are fully represented.
  for (const m of menu) {
    const qty = qtyByPos.get(m.position) || 0;
    const upMealCents = Math.round((m.upcharge_per_meal || 0) * 100);
    upchargeTotal += qty * upMealCents;
    await run(env.DB,
      `INSERT INTO meal_selections (id, subscription_id, week_of, meal_position, meal_name, qty, upcharge_per_meal_cents, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(subscription_id, week_of, meal_position) DO UPDATE SET
         meal_name=excluded.meal_name, qty=excluded.qty, upcharge_per_meal_cents=excluded.upcharge_per_meal_cents, updated_at=excluded.updated_at`,
      `${sub.id}:${weekOf}:${m.position}`, sub.id, weekOf, m.position, m.name, qty, upMealCents, now, now);
  }

  await run(env.DB,
    `INSERT INTO orders (id, subscription_id, customer_id, week_of, status, total_meals, upcharge_total_cents, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
     ON CONFLICT(subscription_id, week_of) DO UPDATE SET
       total_meals=excluded.total_meals, upcharge_total_cents=excluded.upcharge_total_cents, updated_at=excluded.updated_at`,
    `${sub.id}:${weekOf}`, sub.id, customer.id, weekOf, total, upchargeTotal, now, now);

  // Order email. FIRST complete order this week → "you're all set" (once). A later CHANGE before the
  // cutoff → "order updated", but only when the picks actually differ (the dedup key carries a hash of
  // the picks, so re-saving the same set while toggling checkboxes stays silent).
  try {
    const picks = menu.map((m) => ({ name: m.name, qty: qtyByPos.get(m.position) || 0 })).filter((m) => m.qty > 0);
    // Confirmed-vs-updated is decided by ORDER STATE (existingOrder, read above before the upsert), not
    // by a comms row — a delivery hiccup must not corrupt the order flow. No prior order = first pick.
    if (!existingOrder) {
      await notify(env, customer, 'order_confirmed',
        { meals: picks, total, weekOf, upchargeCents: upchargeTotal }, { dedupKey: `order_confirm:${sub.id}:${weekOf}` });
    } else {
      const stateStr = [...qtyByPos.entries()].filter(([, q]) => q > 0).sort((a, b) => a[0] - b[0]).map(([p, q]) => `${p}:${q}`).join(',');
      await notify(env, customer, 'order_updated',
        { meals: picks, total, weekOf, upchargeCents: upchargeTotal },
        { dedupKey: `order_update:${sub.id}:${weekOf}:${stateStr}` });
    }
  } catch { /* non-fatal */ }

  return ok({ week_of: weekOf, total_meals: total, upcharge_total_cents: upchargeTotal });
}
