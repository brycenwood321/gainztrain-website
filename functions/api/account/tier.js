// POST /api/account/tier — change how many meals/week the customer gets.
// Body { meals: 6..16 }. Updates the meal line item's price (per-meal rate may change band) +
// quantity on Stripe, and meals_per_week in D1.
// LOCK AWARENESS: if this week's order is already LOCKED (or the Friday cutoff has passed), the change
// uses proration_behavior=none so it starts NEXT cycle — keeping the bill in step with the meals the
// kitchen is already prepping. If the week is still open, proration_behavior=create_prorations (takes
// effect this week, prorated) and any stale picks at the old count are cleared for a fresh re-pick.
import { ok, fail, readJson } from '../../_lib/respond.js';
import { one, run, nowIso } from '../../_lib/db.js';
import { getSessionCustomer } from '../../_lib/auth.js';
import { stripe } from '../../_lib/stripe.js';
import { currentSub, findMealItem } from '../../_lib/account.js';
import { tierForMeals, ensureStripePrice, MIN_MEALS, MAX_MEALS,
  sizesEnabled, sizeForCustomer, perMealCentsFor, ensureStripePriceForCents } from '../../_lib/plans.js';
import { orderableWeek, isLocked } from '../../_lib/menu.js';
import { notify } from '../../_lib/notify.js';
import { ownerNotify } from '../../_lib/owner_notify.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = await getSessionCustomer(context);
  if (!auth) return fail(401, 'not_authenticated', 'Please log in.');

  const meals = Number((await readJson(request)).meals);
  const tier = tierForMeals(meals);
  if (!tier) return fail(400, 'invalid_meals', `Choose between ${MIN_MEALS} and ${MAX_MEALS} meals per week.`);

  const sub = await currentSub(env, auth.customer.id, ['active', 'trialing', 'past_due', 'paused']);
  if (!sub || !sub.stripe_subscription_id) return fail(400, 'no_active_sub', 'You have no active plan to change.');
  if (sub.meals_per_week === meals) return ok({ meals, tier: tier.key });

  const useSizes = sizesEnabled(env);
  const size = sizeForCustomer(auth.customer);
  const perMealCents = useSizes ? perMealCentsFor(env, size.key, meals) : tier.perMealCents;

  // Is this week already committed (locked order, or past the Friday cutoff)? Drives proration + copy.
  const weekOf = orderableWeek();
  const order = await one(env.DB, `SELECT status, total_meals FROM orders WHERE subscription_id = ? AND week_of = ?`, sub.id, weekOf);
  const weekLocked = isLocked(weekOf) || (order && order.status === 'locked');
  const proration = weekLocked ? 'none' : 'create_prorations';

  try {
    const stripeSub = await stripe(env, 'GET', `subscriptions/${sub.stripe_subscription_id}`);
    const mealItem = findMealItem(stripeSub);
    if (!mealItem) return fail(409, 'meal_item_missing', 'Could not find your meal plan on file — contact us.');
    // Sizes (Build 3): with the flag on, a band change must reprice IN THE CUSTOMER'S SIZE, or a
    // Large customer changing meal count would be silently dropped back to regular pricing.
    const priceId = useSizes
      ? await ensureStripePriceForCents(env, perMealCents, `${size.name} ${tier.name}`)
      : await ensureStripePrice(env, tier);
    // Open week → create_prorations (charge/credit the difference this week). Locked week → none (new
    // amount starts next cycle, matching the meals the kitchen is already prepping — no 3-way mismatch).
    await stripe(env, 'POST', `subscription_items/${mealItem.id}`, {
      price: priceId, quantity: meals, proration_behavior: proration,
    }, `gt_tier_${mealItem.id}_${meals}_${proration}_${stripeSub.current_period_start || ''}`);
    // CRITICAL: also update the subscription metadata.meals_per_week — the webhook re-derives the
    // tier from this tag, so if we don't update it, the next webhook reverts D1 to the old count.
    await stripe(env, 'POST', `subscriptions/${sub.stripe_subscription_id}`, { metadata: { meals_per_week: String(meals), tier: tier.key } });
  } catch (e) {
    return fail(502, 'stripe_failed', String(e?.message || e).slice(0, 160));
  }
  await run(env.DB, `UPDATE subscriptions SET meals_per_week=?, tier_price_cents=?, updated_at=? WHERE id=?`,
    meals, perMealCents, nowIso(), sub.id);

  // Open week with picks already saved at the OLD count → those picks no longer total the new count.
  // Clear them so /app/menu prompts a fresh pick at the new tier (the email says "pick your meals").
  if (!weekLocked && order) {
    try {
      await run(env.DB, `DELETE FROM meal_selections WHERE subscription_id = ? AND week_of = ?`, sub.id, weekOf);
      await run(env.DB, `DELETE FROM orders WHERE subscription_id = ? AND week_of = ?`, sub.id, weekOf);
    } catch { /* non-fatal */ }
  }
  try { await notify(env, auth.customer, 'tier_changed', { meals, perMealCents, nextWeek: !!weekLocked }); } catch { /* non-fatal */ }
  try { const c = auth.customer; await ownerNotify(env, 'owner_tier_changed', `${c.first_name || c.email} changed plan: ${sub.meals_per_week} → ${meals} meals/wk ($${(perMealCents / 100).toFixed(2)}/meal${useSizes ? ', ' + size.name : ''})`, { entity: `customer:${c.id}` }); } catch { /* non-fatal */ }
  return ok({ meals, tier: tier.key, per_meal_cents: perMealCents, effective: weekLocked ? 'next_week' : 'this_week' });
}
