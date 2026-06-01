// POST /api/account/tier — change how many meals/week the customer gets.
// Body { meals: 6..16 }. Updates the meal line item's price (per-meal rate may change band) +
// quantity on Stripe, and meals_per_week in D1. proration_behavior=none → new amount starts next
// cycle; the current already-placed order for this week is unaffected.
import { ok, fail, readJson } from '../../_lib/respond.js';
import { run, nowIso } from '../../_lib/db.js';
import { getSessionCustomer } from '../../_lib/auth.js';
import { stripe } from '../../_lib/stripe.js';
import { currentSub, findItem } from '../../_lib/account.js';
import { tierForMeals, ensureStripePrice, MIN_MEALS, MAX_MEALS } from '../../_lib/plans.js';

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

  try {
    const stripeSub = await stripe(env, 'GET', `subscriptions/${sub.stripe_subscription_id}`);
    const mealItem = findItem(stripeSub, 'gt_meal');
    if (!mealItem) return fail(409, 'meal_item_missing', 'Could not find your meal plan on file — contact us.');
    const priceId = await ensureStripePrice(env, tier);
    await stripe(env, 'POST', `subscription_items/${mealItem.id}`, {
      price: priceId, quantity: meals, proration_behavior: 'none',
    }, `gt_tier_${mealItem.id}_${meals}_${stripeSub.current_period_start || ''}`);
  } catch (e) {
    return fail(502, 'stripe_failed', String(e?.message || e).slice(0, 160));
  }
  await run(env.DB, `UPDATE subscriptions SET meals_per_week=?, tier_price_cents=?, updated_at=? WHERE id=?`,
    meals, tier.perMealCents, nowIso(), sub.id);
  return ok({ meals, tier: tier.key, per_meal_cents: tier.perMealCents });
}
