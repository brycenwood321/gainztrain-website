// GET /api/admin/kitchen-prep?week_of=YYYY-MM-DD — the cook list for a week's LOCKED orders. Admin-gated.
// Returns (all additive, old fields unchanged so the existing UI never breaks):
//   meals[]    — total qty per meal (the original tally)
//   totals     — orders / meals / summed_qty
//   batches[]  — per meal: cook quantities per component (profile-adjusted), e.g. "2.4 kg chicken raw"
//   packing[]  — per order: customer + profile tag + their meals×qty + macros (packing-day + labels source)
//   unmatched / recipes_loaded — meals with no recipe (shopping/batches incomplete) + load status
import { ok, fail } from '../../_lib/respond.js';
import { requireStaffOrAdmin } from '../../_lib/admin.js';
import { one, all } from '../../_lib/db.js';
import { upcomingSunday } from '../../_lib/menu.js';
import { loadRecipes, computeBatches, profileKey } from '../../_lib/recipes.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const denied = await requireStaffOrAdmin(context);
  if (denied) return denied;

  const url = new URL(request.url);
  const week = url.searchParams.get('week_of') || upcomingSunday();

  // KITCHEN PREVIEW (?include_pending=1): count orders that are still OPEN alongside locked ones.
  // Normally the cook list is locked-only, and rightly so — you cook what is final. But when the
  // kitchen has to run before the Saturday lock (2026-08-07: Jayson out of town, so prep moved to
  // Friday), locked-only reports zero and the only way to get a real number was to lock early, which
  // slams the ordering window shut on customers hours before the midnight cutoff they were promised.
  // This flag separates the two: the kitchen sees the full projected list, the customer keeps their
  // window, and the 1:30am lock still runs normally. READ-ONLY — it locks nothing.
  const includePending = url.searchParams.get('include_pending') === '1';
  const orderFilter = includePending
    ? `o.status NOT IN ('skipped_paused','skipped_canceled')`
    : `o.status = 'locked'`;
  const totalsFilter = includePending
    ? `status NOT IN ('skipped_paused','skipped_canceled')`
    : `status = 'locked'`;

  // Original tally (unchanged).
  const meals = await all(env.DB,
    `SELECT ms.meal_position AS position, ms.meal_name AS name, SUM(ms.qty) AS total_qty
       FROM meal_selections ms
       JOIN orders o ON o.subscription_id = ms.subscription_id AND o.week_of = ms.week_of
      WHERE ms.week_of = ? AND ${orderFilter} AND ms.qty > 0
      GROUP BY ms.meal_position, ms.meal_name
      ORDER BY total_qty DESC, ms.meal_position`, week);

  const totals = await one(env.DB,
    `SELECT COUNT(*) AS orders, COALESCE(SUM(total_meals),0) AS meals
       FROM orders WHERE week_of = ? AND ${totalsFilter}`, week);
  const grand = meals.reduce((s, m) => s + (m.total_qty || 0), 0);

  // Per order × meal rows (with goal/sex) — drive batches + packing.
  const rows = await all(env.DB,
    `SELECT o.id AS order_id, ms.meal_position, ms.meal_name, ms.qty,
            c.first_name, c.last_name, c.goal, c.sex,
            COALESCE(o.delivery_method, c.delivery_method) AS method, c.delivery_zone AS zone
       FROM meal_selections ms
       JOIN orders o ON o.subscription_id = ms.subscription_id AND o.week_of = ms.week_of
       JOIN customers c ON c.id = o.customer_id
      WHERE ms.week_of = ? AND ${orderFilter} AND ms.qty > 0
      ORDER BY c.last_name, ms.meal_position`, week);

  // Menu position → slug + macros (for batch matching + label macros).
  const wm = await one(env.DB, `SELECT meals_json FROM weekly_menus WHERE week_of = ?`, week);
  const slugByPosition = {}, macroByPosition = {};
  try {
    (JSON.parse(wm?.meals_json || '[]') || []).forEach((m) => {
      if (m && m.position != null) {
        slugByPosition[m.position] = m.slug;
        macroByPosition[m.position] = { calories: m.calories, protein: m.protein, carbs: m.carbs, fat: m.fat };
      }
    });
  } catch { /* ignore */ }

  let batches = [], unmatched = [], recipesLoaded = false;
  try {
    const lib = await loadRecipes(request, env);
    recipesLoaded = true;
    const r = computeBatches(rows, slugByPosition, lib);
    batches = r.batches; unmatched = r.unmatched;
  } catch { /* recipes.json missing → tallies still work, no batches */ }

  // Packing list: group rows by order.
  const orders = {};
  for (const r of rows) {
    const o = (orders[r.order_id] = orders[r.order_id] || {
      order_id: r.order_id, customer: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
      profile: profileKey(r.goal, r.sex), goal: r.goal, sex: r.sex, method: r.method, zone: r.zone, meals: [],
    });
    const mac = macroByPosition[r.meal_position] || {};
    o.meals.push({ name: r.meal_name, qty: r.qty, calories: mac.calories, protein: mac.protein, carbs: mac.carbs, fat: mac.fat });
  }
  const packing = Object.values(orders);

  return ok({
    week_of: week,
    meals,
    totals: { orders: totals?.orders || 0, meals: totals?.meals || 0, summed_qty: grand },
    batches, packing, unmatched, recipes_loaded: recipesLoaded,
  });
}
