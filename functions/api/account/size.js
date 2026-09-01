// POST /api/account/size (Build 3, behind SIZES_ENABLED). Body { size: 'mini'|'regular'|'large' }.
// Changes the customer's per-customer meal size (decision D1), which changes the per-meal price at
// the same meal count. Mechanics deliberately mirror /api/account/tier: lock-aware proration, price
// swap on the existing meal line item, metadata kept in step so the webhook cannot revert D1.
//
// Custom is not self-serve here either; it starts as a conversation with the owners.
// Portions: until Jayson's gram ladder exists, changing size changes PRICE only; the kitchen keeps
// portioning from sex. The size card in /app/manage says so, so nobody pays Large expecting more
// food before the ladder ships. Once grams exist, this endpoint is where portions follow.
import { ok, fail, readJson } from '../../_lib/respond.js';
import { one, run, nowIso } from '../../_lib/db.js';
import { getSessionCustomer } from '../../_lib/auth.js';
import { stripe } from '../../_lib/stripe.js';
import { currentSub, findMealItem } from '../../_lib/account.js';
import { tierForMeals, sizesEnabled, sizeByKey, perMealCentsFor, ensureStripePriceForCents } from '../../_lib/plans.js';
import { orderableWeek, isLocked } from '../../_lib/menu.js';
import { notify } from '../../_lib/notify.js';
import { ownerNotify } from '../../_lib/owner_notify.js';
import { str } from '../../_lib/validate.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!sizesEnabled(env)) return fail(404, 'not_available', 'Meal sizes are not live yet.');
  const auth = await getSessionCustomer(context);
  if (!auth) return fail(401, 'not_authenticated', 'Please log in.');
  const { customer } = auth;

  const requested = str((await readJson(request)).size).trim().toLowerCase();
  const size = sizeByKey(requested);
  if (!size) return fail(400, 'invalid_size', 'Pick a valid meal size.');
  if (size.key === 'custom') return fail(400, 'custom_is_manual', 'Custom plans are set up with us directly. Text us and we will build yours.');
  if (customer.size_key === size.key) return ok({ size: size.key });

  const sub = await currentSub(env, customer.id, ['active', 'trialing', 'past_due', 'paused']);

  // No live subscription: just remember the choice for their next checkout. Nothing to bill.
  if (!sub || !sub.stripe_subscription_id) {
    try { await run(env.DB, `UPDATE customers SET size_key = ?, updated_at = ? WHERE id = ?`, size.key, nowIso(), customer.id); } catch { /* column pending 0026 */ }
    return ok({ size: size.key, effective: 'next_checkout' });
  }

  const meals = sub.meals_per_week;
  const tier = tierForMeals(meals);
  const perMealCents = perMealCentsFor(env, size.key, meals);
  if (!tier || perMealCents == null) return fail(409, 'no_band', 'Your plan has a meal count outside the normal bands. Contact us to change size.');

  const weekOf = orderableWeek();
  const order = await one(env.DB, `SELECT status FROM orders WHERE subscription_id = ? AND week_of = ?`, sub.id, weekOf);
  const weekLocked = isLocked(weekOf) || (order && order.status === 'locked');
  const proration = weekLocked ? 'none' : 'create_prorations';

  try {
    const stripeSub = await stripe(env, 'GET', `subscriptions/${sub.stripe_subscription_id}`);
    const mealItem = findMealItem(stripeSub);
    if (!mealItem) return fail(409, 'meal_item_missing', 'Could not find your meal plan on file. Contact us.');
    const priceId = await ensureStripePriceForCents(env, perMealCents, `${size.name} ${tier.name}`);
    await stripe(env, 'POST', `subscription_items/${mealItem.id}`, {
      price: priceId, quantity: meals, proration_behavior: proration,
    }, `gt_size_${mealItem.id}_${size.key}_${proration}_${stripeSub.current_period_start || ''}`);
    // Keep metadata in step (webhook re-derives from it). Stripe merges metadata per key.
    await stripe(env, 'POST', `subscriptions/${sub.stripe_subscription_id}`, { metadata: { size_key: size.key } });
  } catch (e) {
    return fail(502, 'stripe_failed', String(e?.message || e).slice(0, 160));
  }

  try { await run(env.DB, `UPDATE customers SET size_key = ?, updated_at = ? WHERE id = ?`, size.key, nowIso(), customer.id); } catch { /* column pending 0026 */ }
  await run(env.DB, `UPDATE subscriptions SET tier_price_cents = ?, updated_at = ? WHERE id = ?`, perMealCents, nowIso(), sub.id);

  try { await notify(env, customer, 'tier_changed', { meals, perMealCents, nextWeek: !!weekLocked }); } catch { /* non-fatal */ }
  try { await ownerNotify(env, 'owner_tier_changed', `${customer.first_name || customer.email} changed size to ${size.name} ($${(perMealCents / 100).toFixed(2)}/meal, ${meals} meals/wk)`, { entity: `customer:${customer.id}` }); } catch { /* non-fatal */ }
  return ok({ size: size.key, per_meal_cents: perMealCents, effective: weekLocked ? 'next_week' : 'this_week' });
}
