// GET /api/admin/shopping-list?week_of=YYYY-MM-DD&buffer=10 — the grocery list for a week's LOCKED
// orders: raw purchase quantities per ingredient, grouped by category, profile-adjusted (goal×sex),
// with an over-buy buffer. Admin-gated. Reads recipes from data/recipes.json (no D1 table).
import { ok, fail } from '../../_lib/respond.js';
import { requireStaffOrAdmin } from '../../_lib/admin.js';
import { one, all } from '../../_lib/db.js';
import { upcomingSunday } from '../../_lib/menu.js';
import { loadRecipes, computeShoppingList } from '../../_lib/recipes.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const denied = await requireStaffOrAdmin(context);
  if (denied) return denied;

  const u = new URL(request.url);
  const week = u.searchParams.get('week_of') || upcomingSunday();
  const buffer = Math.min(50, Math.max(0, parseInt(u.searchParams.get('buffer'), 10) || 10));

  // Per order × meal, with the customer's goal/sex (drives the profile multiplier).
  const rows = await all(env.DB,
    `SELECT ms.meal_position, ms.meal_name, ms.qty, c.goal, c.sex
       FROM meal_selections ms
       JOIN orders o ON o.subscription_id = ms.subscription_id AND o.week_of = ms.week_of
       JOIN customers c ON c.id = o.customer_id
      WHERE ms.week_of = ? AND o.status = 'locked' AND ms.qty > 0`, week);

  const totals = await one(env.DB,
    `SELECT COUNT(*) AS orders, COALESCE(SUM(total_meals),0) AS meals FROM orders WHERE week_of = ? AND status = 'locked'`, week);

  // Map menu position → recipe slug (if the published menu carries slugs). Falls back to name matching.
  const wm = await one(env.DB, `SELECT meals_json FROM weekly_menus WHERE week_of = ?`, week);
  const slugByPosition = {};
  try { (JSON.parse(wm?.meals_json || '[]') || []).forEach((m) => { if (m && m.position != null) slugByPosition[m.position] = m.slug; }); } catch { /* ignore */ }

  let lib;
  try { lib = await loadRecipes(request); }
  catch (e) { return ok({ week_of: week, recipes_loaded: false, error: String(e).slice(0, 120), totals: { orders: totals?.orders || 0, meals: totals?.meals || 0 }, categories: [], unmatched: [] }); }

  const { categories, unmatched, cost } = computeShoppingList(rows, slugByPosition, lib, buffer);
  const meals = totals?.meals || 0;
  // Cost per meal uses the EXACT food cost (no over-buy buffer) — that's the true per-container ingredient
  // cost to compare against the ~$8.50/meal price. Buffer is a purchasing reality, not per-meal economics.
  const costPerMealCents = meals > 0 ? Math.round((cost?.food_cost_exact_cents || 0) / meals) : 0;
  return ok({
    week_of: week, recipes_loaded: true, buffer_pct: buffer,
    totals: { orders: totals?.orders || 0, meals },
    cost: { ...cost, cost_per_meal_cents: costPerMealCents },
    categories, unmatched,
  });
}
