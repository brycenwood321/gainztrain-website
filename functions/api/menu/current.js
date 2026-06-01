// GET /api/menu/current — the week the customer should be ordering for: the menu, their tier's
// meal allowance, their current picks for that week, and whether ordering is locked (Friday cutoff).
// Session-gated (it's the in-app meal picker).
import { ok, fail } from '../../_lib/respond.js';
import { one, all } from '../../_lib/db.js';
import { getSessionCustomer } from '../../_lib/auth.js';
import { orderableWeek, cutoffForWeek, isLocked } from '../../_lib/menu.js';

export async function onRequestGet(context) {
  const auth = await getSessionCustomer(context);
  if (!auth) return fail(401, 'not_authenticated', 'Please log in.');
  const { env } = context;
  const { customer } = auth;

  const week = orderableWeek();
  // The orderable week's menu, else the most recent published menu as a fallback.
  let menuRow = await one(env.DB, `SELECT week_of, label, meals_json FROM weekly_menus WHERE week_of = ?`, week);
  if (!menuRow) menuRow = await one(env.DB, `SELECT week_of, label, meals_json FROM weekly_menus ORDER BY week_of DESC LIMIT 1`);
  const meals = menuRow ? JSON.parse(menuRow.meals_json) : [];
  const weekOf = menuRow ? menuRow.week_of : week;

  const sub = await one(env.DB,
    `SELECT id, status, meals_per_week FROM subscriptions
     WHERE customer_id = ? AND status IN ('active','trialing','past_due','paused') ORDER BY created_at DESC LIMIT 1`,
    customer.id);

  const selections = sub
    ? await all(env.DB,
        `SELECT meal_position, qty FROM meal_selections WHERE subscription_id = ? AND week_of = ?`,
        sub.id, weekOf)
    : [];

  return ok({
    week_of: weekOf,
    label: menuRow?.label || null,
    meals,
    meals_per_week: sub?.meals_per_week ?? null,
    has_active_sub: !!sub,
    selections,                                  // [{meal_position, qty}]
    cutoff: cutoffForWeek(weekOf).toISOString(),
    locked: isLocked(weekOf),
  });
}
