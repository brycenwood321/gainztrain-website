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
  // Collapse the tally onto the menu's current name. A rename splits one dish into two rows here
  // (the GROUP BY includes meal_name), so merge by position after resolving the name.
  const tallyByPos = new Map();
  for (const m of meals) {
    const prev = tallyByPos.get(m.position);
    if (prev) prev.total_qty += (m.total_qty || 0);
    else tallyByPos.set(m.position, { position: m.position, name: displayName(m.position, m.name), total_qty: m.total_qty || 0 });
  }
  const mealsResolved = [...tallyByPos.values()].sort((a, b) => b.total_qty - a.total_qty || a.position - b.position);
  const grand = mealsResolved.reduce((s, m) => s + (m.total_qty || 0), 0);

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
  const slugByPosition = {}, macroByPosition = {}, nameByPosition = {};
  try {
    (JSON.parse(wm?.meals_json || '[]') || []).forEach((m) => {
      if (m && m.position != null) {
        slugByPosition[m.position] = m.slug;
        macroByPosition[m.position] = { calories: m.calories, protein: m.protein, carbs: m.carbs, fat: m.fat };
        nameByPosition[m.position] = m.name;
      }
    });
  } catch { /* ignore */ }

  // ⚠️ THE MENU'S CURRENT NAME WINS OVER THE COPY STORED ON THE SELECTION (2026-09-15).
  // meal_selections.meal_name is a snapshot taken when the customer picked. Rename or swap a meal
  // mid-week and every order placed before that keeps the OLD name, so one dish reports as two lines:
  // week 2026-09-20 showed Steak Fajita as 4 + 3 and Tomato Chicken as 3 + 2 after a spelling fix.
  // Recipes already resolved correctly because they go by POSITION, so this was never a buying
  // problem, only a counting one, and it split the number the kitchen cooks against. Falls back to
  // the stored name when the position is no longer on the menu (a meal removed after someone ordered).
  const displayName = (position, stored) => nameByPosition[position] || stored;

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
    o.meals.push({ name: displayName(r.meal_position, r.meal_name), qty: r.qty, calories: mac.calories, protein: mac.protein, carbs: mac.carbs, fat: mac.fat });
  }
  const packing = Object.values(orders);

  return ok({
    week_of: week,
    meals: mealsResolved,
    totals: { orders: totals?.orders || 0, meals: totals?.meals || 0, summed_qty: grand },
    batches, packing, unmatched, recipes_loaded: recipesLoaded,
  });
}
