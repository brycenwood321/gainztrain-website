// recipes.js: turns locked meal selections into a shopping list + cook batches. Reads the OWNER-EDITABLE
// meal + ingredient libraries out of ops_kv (see loadRecipes), so what the dashboard shows and what the
// kitchen buys can never drift apart again. Pure functions so shopping-list and kitchen-prep share them.
//
// grams_cooked in recipes.json = what the kitchen portions into a container. Raw purchase weight =
// grams_cooked / ingredient.yield_factor. Per-customer goal×sex scales grams via profiles[goal_sex].

import { one } from './db.js';

const CATS = ['protein', 'carb', 'produce', 'pantry'];
const LB = 453.592;

// ── ONE RECIPE LIST (2026-08-31) ───────────────────────────────────────────────────────────────
// There used to be TWO. This file read the static data/recipes.json (8 recipes, editable only by a
// developer), while the ops dashboard read `meal_library` in ops_kv (14 meals, editable by owners).
// They drifted, silently. Marissa and Jayson added BBQ Chicken, Beef Broccoli Rice and Yogurt
// Parfait in the dashboard, saw them save, and the shopping list never bought a gram of any of
// them: 4 of the 6 meals on the week of 2026-09-06 contributed NOTHING. Same trap as the old
// menus.json split. The editable library is now the source of truth and the static file is
// demoted to a PRICE TABLE, because ingredient_library carries no cost_per_kg yet.
//
// The library's numbers are also the correct ones. Its math reproduces the signed-off worked
// example exactly (Fiesta Chicken, 8 female + 10 male: 10 x 162g + 8 x 105g = 2,460g cooked
// chicken, raw 2,460 x 1.8 shrinkage = 4,428g). The static file disagreed on BOTH counts: it had
// no batch pooling, and chicken yield_factor 0.75 (raw = cooked / 0.75 = 1.33x) against the
// library's confirmed 1.8x. It was under-buying chicken by about a quarter on every meal it did
// know about, on top of the meals it did not.
const CAT_MAP = { protein: 'protein', carbs: 'carb', veggies: 'produce', misc: 'pantry' };
// Portion targets are GENDER ONLY (Marissa, 2026-07-14). Goal does not change grams. Male is the
// 1.0 baseline so profiles below express female as a per-category ratio of it.
const TARGETS = {
  male:   { protein: 170, carbs: 140, veggies: 100 },
  female: { protein: 115, carbs: 100, veggies: 60 },
};
const GENDER_PROFILES = {
  male:   { protein: 1, carb: 1, produce: 1, pantry: 1, fat: 1 },
  female: {
    protein: TARGETS.female.protein / TARGETS.male.protein,
    carb:    TARGETS.female.carbs   / TARGETS.male.carbs,
    produce: TARGETS.female.veggies / TARGETS.male.veggies,
    pantry: 1, fat: 1,
  },
};
export const slugifyName = (s) => String(s == null ? '' : s).toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function loadStaticRecipes(request) {
  const res = await fetch(new URL('/data/recipes.json', request.url));
  if (!res.ok) throw new Error(`recipes.json returned ${res.status}`);
  const data = await res.json();
  return { ingredients: data.ingredients || {}, recipes: data.recipes || {}, profiles: data.profiles || {} };
}

async function opsKv(env, key) {
  try {
    const row = await one(env.DB, `SELECT value_json FROM ops_kv WHERE key = ?`, key);
    if (!row || !row.value_json) return null;
    const v = JSON.parse(row.value_json);
    return Array.isArray(v) && v.length ? v : null;
  } catch { return null; }
}

// Convert the dashboard's editable libraries into the shape the compute functions below already use.
// Dashboard model: each ingredient carries a PERCENTAGE of its category's gram target, and batched
// categories pool their targets before the split. Misc items (pct null) are eyeballed and weigh
// nothing, which is why they contribute 0 grams here rather than a guess.
// Grams per named purchase unit, for turning a package (e.g. "10 lbs") into grams. An unknown unit
// string falls back to the ingredient's own grams_per_unit when the units match, else null: a pack
// we cannot weigh gets no pack math rather than wrong pack math.
const UNIT_G = { lb: 453.592, lbs: 453.592, pound: 453.592, pounds: 453.592, oz: 28.3495, kg: 1000, g: 1 };
function unitGrams(unitStr, ing) {
  const u = String(unitStr || '').toLowerCase().trim();
  if (UNIT_G[u]) return UNIT_G[u];
  if (!u || u === String(ing.unit || '').toLowerCase().trim()) {
    const g = Number(ing.grams_per_unit);
    return g > 0 ? g : null;
  }
  return null;
}

function libraryToRecipes(meals, ingredients, priceLib) {
  const priceByName = {};
  for (const [, ing] of Object.entries(priceLib.ingredients || {})) {
    if (ing && ing.name) priceByName[normalizeName(ing.name)] = ing;
  }
  const outIng = {};
  for (const ing of ingredients) {
    if (!ing || !ing.name) continue;
    const priced = priceByName[normalizeName(ing.name)];
    const shrink = Number(ing.shrinkage) > 0 ? Number(ing.shrinkage) : 1;
    // SKU map (2026-08-31): a REAL price is a price_per_package_cents the owners typed off the
    // receipt of whichever store sells it (usually Sam's, not always), on a package whose gram
    // weight we can compute. `store` + `store_item` record WHERE it is bought so a stand-in
    // shopper can run the list. The static file's cost_per_kg values are placeholder averages and
    // are labelled as such, so no total built on them can ever read as the real food cost.
    const pkgSize = Number(ing.package_size) > 0 ? Number(ing.package_size) : null;
    const pkgUnitG = pkgSize ? unitGrams(ing.package_size_unit, ing) : null;
    const packageGrams = pkgSize && pkgUnitG ? pkgSize * pkgUnitG : null;
    const priceCents = Number.isFinite(Number(ing.price_per_package_cents)) ? Number(ing.price_per_package_cents) : null;
    let costPerKg = null, priceSource = null;
    if (priceCents != null && packageGrams) {
      costPerKg = (priceCents / 100) / (packageGrams / 1000);
      priceSource = 'library';
    } else if (priced && typeof priced.cost_per_kg === 'number') {
      costPerKg = priced.cost_per_kg;
      priceSource = 'static_placeholder';
    }
    outIng[slugifyName(ing.name)] = {
      name: ing.name,
      category: 'pantry',                 // overwritten per use below from the meal's own category
      yield_factor: 1 / shrink,           // server divides by this; library multiplies by shrinkage
      cost_per_kg: costPerKg,
      price_source: priceSource,
      store: ing.store || null,
      store_item: ing.store_item || ing.sams_item || null,
      price_per_package_cents: priceCents,
      package_grams: packageGrams,
      is_misc: !!ing.is_misc,
      unit: ing.unit || null,
      package_size: ing.package_size == null ? null : Number(ing.package_size),
      package_size_unit: ing.package_size_unit || null,
    };
  }
  const outRecipes = {};
  for (const meal of meals) {
    if (!meal || !meal.name) continue;
    const batched = meal.mode === 'batch' && Array.isArray(meal.batch_categories) ? meal.batch_categories : [];
    const batchTotal = batched.reduce((s, c) => s + (TARGETS.male[c] || 0), 0);
    const items = [];
    for (const line of (meal.ingredients || [])) {
      if (!line || !line.item) continue;
      const slug = slugifyName(line.item);
      const cat = CAT_MAP[line.category] || 'pantry';
      if (outIng[slug]) outIng[slug].category = cat;
      const pct = Number(line.pct);
      if (!Number.isFinite(pct) || pct <= 0) continue;   // misc / eyeball: no weight to buy by
      // Grams are resolved PER SEX here rather than left to a per-category multiplier downstream.
      // On a batched meal the pooled denominator is that sex's own targets, so Fiesta Chicken's
      // 60% chicken is 60% of male 170+100=270 (162g) but 60% of female 115+60=175 (105g). A single
      // protein-category ratio would have given 110g, over-buying every batched meal by ~5%.
      const gramsFor = (sex) => {
        const t = TARGETS[sex];
        const denom = batched.includes(line.category)
          ? batched.reduce((s, c) => s + (t[c] || 0), 0)
          : (t[line.category] || 0);
        return denom ? (denom * pct) / 100 : 0;
      };
      const male = gramsFor('male');
      if (!male) continue;
      items.push({ ingredient: slug, grams_cooked: male, grams_by_sex: { male, female: gramsFor('female') } });
    }
    outRecipes[slugifyName(meal.name)] = { names: [meal.name], items };
  }
  return { ingredients: outIng, recipes: outRecipes, profiles: {
    maintain_male: GENDER_PROFILES.male, cut_male: GENDER_PROFILES.male, build_male: GENDER_PROFILES.male,
    maintain_female: GENDER_PROFILES.female, cut_female: GENDER_PROFILES.female, build_female: GENDER_PROFILES.female,
  } };
}

export async function loadRecipes(request, env) {
  const staticLib = await loadStaticRecipes(request);   // prices, and the fallback if D1 is unreachable
  // `source` says which engine actually answered. A checker that cannot tell live from fallback
  // would happily re-verify the demoted price table, which is the drift this system just closed.
  if (!env || !env.DB) return { ...staticLib, source: 'static_fallback' };
  const [meals, ingredients] = await Promise.all([opsKv(env, 'meal_library'), opsKv(env, 'ingredient_library')]);
  if (!meals || !ingredients) return { ...staticLib, source: 'static_fallback' };  // never leave the kitchen with no list at all
  return { ...libraryToRecipes(meals, ingredients, staticLib), source: 'ops_kv' };
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
    if (!res) { unmatched.push({ name: row.meal_name, position: row.meal_position, qty: row.qty, reason: 'no recipe found' }); continue; }
    // ⚠️ A recipe that EXISTS but has no items is the dangerous case, and it is
    // why the shopping list has under-bought every week Protein Baked Ziti is on
    // the menu. `protein-ziti` resolves fine, so it never landed in `unmatched`,
    // then the items loop below ran zero times and it contributed no ingredients
    // at all. The list came out looking complete while being short a whole meal.
    //
    // A missing recipe was already loud. An EMPTY one was silent, which is worse.
    // Do not "fix" this by inventing quantities: a plausible wrong shopping list
    // is more damaging than a visible gap, because nobody checks a list that
    // looks right. Jayson owns the real recipe.
    if (!res.recipe || !(res.recipe.items || []).length) {
      unmatched.push({ name: row.meal_name, position: row.meal_position, qty: row.qty,
                       reason: 'recipe exists but has NO ingredients, so this meal buys nothing' });
      continue;
    }
    const pkey = profileKey(row.goal, row.sex);
    for (const item of (res.recipe.items || [])) {
      const ing = ingredients[item.ingredient];
      const cat = (ing && ing.category) || 'pantry';
      // grams_by_sex is already resolved against that sex's own targets (and batch pooling), so it
      // must NOT be scaled again by the category multiplier. The multiplier path stays for the
      // static-file fallback, which only carries a single baseline gram figure per item.
      const g = item.grams_by_sex
        ? (item.grams_by_sex[row.sex === 'female' ? 'female' : 'male'] || 0) * (row.qty || 0)
        : (item.grams_cooked || 0) * (row.qty || 0) * mult(profiles, pkey, cat);
      cooked[item.ingredient] = (cooked[item.ingredient] || 0) + g;
      (usedIn[item.ingredient] = usedIn[item.ingredient] || new Set()).add(row.meal_name);
    }
  }
  const buf = 1 + Math.max(0, bufferPct) / 100;
  const byCat = {};
  // Food-cost rollup. cost_per_kg (raw $/kg) lives on each ingredient in recipes.json (placeholder
  // averages until Brycen drops in real supplier pricing). We cost the BUFFERED raw weight = what you
  // actually buy. exact = the food that ends up in containers (no over-buy). Any ingredient missing a
  // price is listed in `unpriced` so the UI can flag that the total is understated.
  let foodCostCents = 0, foodCostExactCents = 0;
  let realCostCents = 0, placeholderCostCents = 0, packsCostCents = 0, packsAllPriced = true;
  const unpriced = [];
  for (const [slug, cookedG] of Object.entries(cooked)) {
    const ing = ingredients[slug] || { name: slug, category: 'pantry', yield_factor: 1 };
    const cat = ing.category || 'pantry';
    const yf = ing.yield_factor || 1;
    const rawExact = cookedG / yf;
    const rawBuf = rawExact * buf;
    const pricePerKg = (typeof ing.cost_per_kg === 'number' && ing.cost_per_kg >= 0) ? ing.cost_per_kg : null;
    const costCents = pricePerKg != null ? Math.round((rawBuf / 1000) * pricePerKg * 100) : null;
    const costExactCents = pricePerKg != null ? Math.round((rawExact / 1000) * pricePerKg * 100) : null;
    if (pricePerKg == null) unpriced.push(ing.name || slug);
    else {
      foodCostCents += costCents; foodCostExactCents += costExactCents;
      if (ing.price_source === 'library') realCostCents += costCents;
      else placeholderCostCents += costCents;
    }
    // Pack math (SKU map): whole packages at the receipt price = what leaves the bank account,
    // as opposed to the theoretical per-gram cost above.
    const packs = ing.package_grams ? Math.ceil(rawBuf / ing.package_grams) : null;
    const packCost = packs != null && ing.price_per_package_cents != null ? packs * ing.price_per_package_cents : null;
    if (packCost != null) packsCostCents += packCost; else packsAllPriced = false;
    (byCat[cat] = byCat[cat] || []).push({
      ingredient: slug, name: ing.name, category: cat,
      grams_cooked_total: Math.round(cookedG),
      grams_raw_exact: Math.round(rawExact),
      grams_raw_buffered: Math.round(rawBuf),
      lb_buffered: Math.round((rawBuf / LB) * 100) / 100,
      kg_buffered: Math.round((rawBuf / 1000) * 100) / 100,
      cost_per_kg: pricePerKg,
      price_source: ing.price_source || null,
      cost_cents: costCents,
      packs,
      package_size: ing.package_size || null,
      package_size_unit: ing.package_size_unit || null,
      store: ing.store || null,
      store_item: ing.store_item || null,
      pack_cost_cents: packCost,
      used_in: [...(usedIn[slug] || [])],
    });
  }
  const categories = CATS.filter((c) => byCat[c]).map((c) => ({
    category: c,
    items: byCat[c].sort((a, b) => b.grams_raw_buffered - a.grams_raw_buffered),
    cost_cents: byCat[c].reduce((s, i) => s + (i.cost_cents || 0), 0),
  }));
  const cost = {
    food_cost_cents: foodCostCents,            // what you BUY this week (incl. over-buy buffer)
    food_cost_exact_cents: foodCostExactCents, // food that ends up in containers (no buffer)
    unpriced,                                  // ingredient names with no price at all
    // The honesty split (2026-08-31): only 'real' comes from owner-entered package prices; the
    // rest is placeholder averages. A margin decision may be made on real, never on the blend.
    food_cost_real_cents: realCostCents,
    food_cost_placeholder_cents: placeholderCostCents,
    // Whole-packs total at receipt prices; null until every bought ingredient carries pack + price,
    // because a partial packs total reads like the shopping bill and is not.
    packs_cost_cents: packsAllPriced ? packsCostCents : null,
    packs_cost_partial_cents: packsCostCents,
  };
  return { categories, unmatched, cost };
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
      // grams_by_sex is already resolved against that sex's own targets (and batch pooling), so it
      // must NOT be scaled again by the category multiplier. The multiplier path stays for the
      // static-file fallback, which only carries a single baseline gram figure per item.
      const g = item.grams_by_sex
        ? (item.grams_by_sex[row.sex === 'female' ? 'female' : 'male'] || 0) * (row.qty || 0)
        : (item.grams_cooked || 0) * (row.qty || 0) * mult(profiles, pkey, cat);
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
