// GET /api/admin/recipe-coverage?week_of=YYYY-MM-DD
//
// Does every meal on the (given or orderable) week's menu resolve to a recipe with ingredients,
// in the engine that ACTUALLY buys the food? Built 2026-08-31 so gt-menu-recipe-check on the Mac
// stops watching data/recipes.json, which the 5eb05fd consolidation demoted to a price table.
// The check now asks the same loadRecipes the shopping list uses, so it can no longer drift from
// the thing it guards.
//
// Both failure modes are covered: no recipe for the slug, and a recipe with ZERO items. The second
// used to resolve fine and silently buy nothing, which is how Ziti hid for weeks.
import { json } from '../../_lib/respond.js';
import { one } from '../../_lib/db.js';
import { requireStaffOrAdmin } from '../../_lib/admin.js';
import { orderableWeek } from '../../_lib/menu.js';
import { loadRecipes, resolveRecipe } from '../../_lib/recipes.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const denied = await requireStaffOrAdmin(context); if (denied) return denied;

  const u = new URL(request.url);
  const week = u.searchParams.get('week_of') || orderableWeek();

  const wm = await one(env.DB, `SELECT meals_json, status FROM weekly_menus WHERE week_of = ?`, week);
  if (!wm) return json({ ok: true, week_of: week, menu_found: false, meals: [], missing: [] }, 200);

  let menuMeals = [];
  try { menuMeals = JSON.parse(wm.meals_json || '[]') || []; } catch { menuMeals = []; }

  const lib = await loadRecipes(request, env);
  const meals = [], missing = [];
  for (const m of menuMeals) {
    const hit = resolveRecipe(m, lib.recipes || {});
    const items = hit ? (hit.recipe.items || []).length : 0;
    const okMeal = !!hit && items > 0;
    const row = {
      position: m.position, name: m.name || '', slug: (hit && hit.slug) || m.slug || '',
      items, ok: okMeal,
      why: okMeal ? '' : (!hit ? 'no recipe resolves for this meal' : 'recipe exists but has ZERO ingredients'),
    };
    meals.push(row);
    if (!okMeal) missing.push(row);
  }

  return json({
    ok: true, week_of: week, menu_found: true, menu_status: wm.status || 'live',
    recipe_source: lib.source || 'unknown',
    meals, missing,
    counts: { meals: meals.length, missing: missing.length },
  }, 200);
}
