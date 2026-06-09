// GET /api/admin/kitchen-prep?week_of=YYYY-MM-DD — the cook list for a week: total quantity per meal
// across every LOCKED order, plus the headcount. Admin-gated. This is what Jayson cooks from.
import { ok, fail } from '../../_lib/respond.js';
import { requireAdmin } from '../../_lib/admin.js';
import { one, all } from '../../_lib/db.js';
import { upcomingSunday } from '../../_lib/menu.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const denied = await requireAdmin(context);
  if (denied) return denied;

  const week = new URL(request.url).searchParams.get('week_of') || upcomingSunday();

  // Sum picked quantities across locked orders only (join keeps us to orders the kitchen actually makes).
  const meals = await all(env.DB,
    `SELECT ms.meal_position AS position, ms.meal_name AS name, SUM(ms.qty) AS total_qty
       FROM meal_selections ms
       JOIN orders o ON o.subscription_id = ms.subscription_id AND o.week_of = ms.week_of
      WHERE ms.week_of = ? AND o.status = 'locked' AND ms.qty > 0
      GROUP BY ms.meal_position, ms.meal_name
      ORDER BY total_qty DESC, ms.meal_position`, week);

  const totals = await one(env.DB,
    `SELECT COUNT(*) AS orders, COALESCE(SUM(total_meals),0) AS meals
       FROM orders WHERE week_of = ? AND status = 'locked'`, week);

  const grand = meals.reduce((s, m) => s + (m.total_qty || 0), 0);
  return ok({
    week_of: week,
    meals,
    totals: { orders: totals?.orders || 0, meals: totals?.meals || 0, summed_qty: grand },
  });
}
