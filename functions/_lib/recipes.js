// recipes.js — turns locked meal selections into a shopping list + cook batches, using data/recipes.json.
// Mirrors publish-menu's "fetch the JSON file live" pattern (no D1 table, no migration). Pure functions
// so both the shopping-list endpoint and the kitchen-prep batches share one source of truth.
//
// grams_cooked in recipes.json = what the kitchen portions into a container. Raw purchase weight =
// grams_cooked / ingredient.yield_factor. Per-customer goal×sex scales grams via profiles[goal_sex].

const CATS = ['protein', 'carb', 'produce', 'pantry'];
const LB = 453.592;

export async function loadRecipes(request) {
  const res = await fetch(new URL('/data/recipes.json', request.url));
  if (!res.ok) throw new Error(`recipes.json returned ${res.status}`);
  const data = await res.json();
  return { ingredients: data.ingredients || {}, recipes: data.recipes || {}, profiles: data.profiles || {} };
}

export function normalizeName(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Resolve a menu meal → recipe. Prefer the explicit slug; fall back to a normalized-name match against
// every recipe's `names` aliases (menu names drift over weeks). Returns { slug, recipe } or null.
export function resolveRecipe(meal, recipes) {
  if (meal && meal.slug && recipes[meal.slug]) return { slug: meal.slug, recipe: recipes[meal.slug] };
  const want = normalizeName(meal && meal.name);
  if (!want) return null;
  for (const slug of Object.keys(recipes)) {
    const r = recipes[slug];
    if ((r.names || []).some((n) => normalizeName(n) === want)) return { slug, recipe: r };
  }
  return null;
}

// goal ∈ {cut,maintain,build}, sex ∈ {male,female}. Anything missing → maintain_male (baseline).
export function profileKey(goal, sex) {
  const g = ['cut', 'maintain', 'build'].includes(goal) ? goal : 'maintain';
  const s = sex === 'female' ? 'female' : 'male';
  return `${g}_${s}`;
}

function mult(profiles, key, category) {
  const p = profiles[key];
  if (!p || typeof p[category] !== 'number') return 1;
  return p[category];
}

// Build the shopping list. rows: [{ meal_position, meal_name, qty, goal, sex }] (per order×meal, locked).
// slugByPosition: { [position]: slug } from the week's published menu (improves name matching). Because the profile multiplier is category-specific, we must apply it per item
// (we know the ingredient's category from `ingredients`). So we aggregate inline here, not via accumulate.
export function computeShoppingList(rows, slugByPosition, lib, bufferPct = 10) {
  const { ingredients, recipes, profiles } = lib;
  const cooked = {}; // ingredient slug → cooked grams (profile-adjusted)
  const usedIn = {}; // ingredient slug → Set(meal names)
  const unmatched = [];
  for (const row of rows) {
    const slug = slugByPosition[row.meal_position];
    const res = resolveRecipe({ name: row.meal_name, slug }, recipes);
    if (!res) { unmatched.push({ name: row.meal_name, position: row.meal_position, qty: row.qty }); continue; }
    const pkey = profileKey(row.goal, row.sex);
    for (const item of (res.recipe.items || [])) {
      const ing = ingredients[item.ingredient];
      const cat = (ing && ing.category) || 'pantry';
      const g = (item.grams_cooked || 0) * (row.qty || 0) * mult(profiles, pkey, cat);
      cooked[item.ingredient] = (cooked[item.ingredient] || 0) + g;
      (usedIn[item.ingredient] = usedIn[item.ingredient] || new Set()).add(row.meal_name);
    }
  }
  const buf = 1 + Math.max(0, bufferPct) / 100;
  const byCat = {};
  for (const [slug, cookedG] of Object.entries(cooked)) {
    const ing = ingredients[slug] || { name: slug, category: 'pantry', yield_factor: 1 };
    const cat = ing.category || 'pantry';
    const yf = ing.yield_factor || 1;
    const rawExact = cookedG / yf;
    const rawBuf = rawExact * buf;
    (byCat[cat] = byCat[cat] || []).push({
      ingredient: slug, name: ing.name, category: cat,
      grams_cooked_total: Math.round(cookedG),
      grams_raw_exact: Math.round(rawExact),
      grams_raw_buffered: Math.round(rawBuf),
      lb_buffered: Math.round((rawBuf / LB) * 100) / 100,
      kg_buffered: Math.round((rawBuf / 1000) * 100) / 100,
      used_in: [...(usedIn[slug] || [])],
    });
  }
  const categories = CATS.filter((c) => byCat[c]).map((c) => ({
    category: c,
    items: byCat[c].sort((a, b) => b.grams_raw_buffered - a.grams_raw_buffered),
  }));
  return { categories, unmatched };
}

// Per-meal cook batches: total cooked + raw grams of each component for that meal (profile-adjusted),
// so Jayson knows "cook 2.4 kg chicken / 3.2 kg raw for the 14 Bro-Tato bowls".
// mealRows: [{ position, name, slug?, qty, components? }] aggregated per meal isn't enough (we need the
// per-order goal/sex), so we take the same raw rows and group by meal here.
export function computeBatches(rows, slugByPosition, lib) {
  const { ingredients, recipes, profiles } = lib;
  const byMeal = {}; // key position|name → { position, name, slug, total_qty, comp: {ing: cookedG} }
  const unmatched = [];
  for (const row of rows) {
    const slug = slugByPosition[row.meal_position];
    const res = resolveRecipe({ name: row.meal_name, slug }, recipes);
    const key = `${row.meal_position}|${row.meal_name}`;
    const m = (byMeal[key] = byMeal[key] || { position: row.meal_position, name: row.meal_name, slug: res ? res.slug : null, total_qty: 0, comp: {} });
    m.total_qty += (row.qty || 0);
    if (!res) { if (!unmatched.find((u) => u.name === row.meal_name)) unmatched.push({ name: row.meal_name, position: row.meal_position }); continue; }
    const pkey = profileKey(row.goal, row.sex);
    for (const item of (res.recipe.items || [])) {
      const ing = ingredients[item.ingredient];
      const cat = (ing && ing.category) || 'pantry';
      const g = (item.grams_cooked || 0) * (row.qty || 0) * mult(profiles, pkey, cat);
      m.comp[item.ingredient] = (m.comp[item.ingredient] || 0) + g;
    }
  }
  const batches = Object.values(byMeal).map((m) => ({
    position: m.position, name: m.name, slug: m.slug, total_qty: m.total_qty,
    components: Object.entries(m.comp).map(([slug, cookedG]) => {
      const ing = ingredients[slug] || { name: slug, yield_factor: 1 };
      const yf = ing.yield_factor || 1;
      return {
        ingredient: slug, name: ing.name,
        grams_cooked_total: Math.round(cookedG),
        grams_raw_total: Math.round(cookedG / yf),
        kg_cooked: Math.round((cookedG / 1000) * 100) / 100,
        kg_raw: Math.round((cookedG / yf / 1000) * 100) / 100,
      };
    }).sort((a, b) => b.grams_cooked_total - a.grams_cooked_total),
  })).sort((a, b) => b.total_qty - a.total_qty);
  return { batches, unmatched };
}
