// Meal substitution for the Friday-cutoff auto-fill: when a customer doesn't pick, we repeat last
// week's meals. If one of last week's meals isn't on the new menu, we substitute the CLOSEST one —
// same protein first, then closest macros (Brycen's rule).

const PROTEINS = ['chicken', 'beef', 'steak', 'turkey', 'salmon', 'fish', 'shrimp', 'pork', 'egg', 'tofu'];

export function proteinOf(name) {
  const n = (name || '').toLowerCase();
  for (const p of PROTEINS) if (n.includes(p)) return p === 'fish' ? 'salmon' : p;
  return 'other';
}

// Macro distance — protein weighted heaviest (it's the whole point), then calories, carbs, fat.
function macroDistance(a, b) {
  return 6 * Math.abs((a.protein || 0) - (b.protein || 0))
    + 1 * Math.abs((a.calories || 0) - (b.calories || 0))
    + 2 * Math.abs((a.carbs || 0) - (b.carbs || 0))
    + 2 * Math.abs((a.fat || 0) - (b.fat || 0));
}

// Map a previous-week meal onto THIS week's menu. Exact name match wins; else same protein +
// closest macros; else closest macros overall. Returns the chosen menu meal (with .position).
export function substitute(prevMeal, menu) {
  if (!menu.length) return null;
  const exact = menu.find((m) => m.name === prevMeal.name);
  if (exact) return exact;
  const prot = proteinOf(prevMeal.name);
  const sameProtein = menu.filter((m) => proteinOf(m.name) === prot);
  const pool = sameProtein.length ? sameProtein : menu;
  return pool.reduce((best, m) => (macroDistance(prevMeal, m) < macroDistance(prevMeal, best) ? m : best), pool[0]);
}

// Build this-week quantities by position from last week's (mealByPosition, qtyByPosition).
// prevMenu = last week's meals (for name/macros); menu = this week's meals.
export function repeatLastWeek(prevMeals, prevQtyByPos, menu) {
  const out = new Map(); // position -> qty
  for (const pm of prevMeals) {
    const qty = prevQtyByPos.get(pm.position) || 0;
    if (qty <= 0) continue;
    const target = substitute(pm, menu);
    if (!target) continue;
    out.set(target.position, (out.get(target.position) || 0) + qty);
  }
  return out;
}

// Fallback when a customer has NO history: spread mealsPerWeek as evenly as possible across the menu.
export function evenSpread(menu, mealsPerWeek) {
  const out = new Map();
  if (!menu.length) return out;
  for (let i = 0; i < mealsPerWeek; i++) {
    const pos = menu[i % menu.length].position;
    out.set(pos, (out.get(pos) || 0) + 1);
  }
  return out;
}
