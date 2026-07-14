// GET /api/me — the read-only "See My Account" view. Session-authenticated.
// Reads ONLY from D1 (the single source of truth). No writes, no billing actions.
import { ok, fail } from '../_lib/respond.js';
import { all, one } from '../_lib/db.js';
import { getSessionCustomer } from '../_lib/auth.js';
import { tierForMeals } from '../_lib/plans.js';

export async function onRequestGet(context) {
  const auth = await getSessionCustomer(context);
  if (!auth) return fail(401, 'not_authenticated', 'Please log in.');
  const { env } = context;
  const { customer } = auth;

  const sub = await one(
    env.DB,
    `SELECT * FROM subscriptions WHERE customer_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    customer.id,
  );

  const orders = await all(
    env.DB,
    `SELECT week_of, status, total_meals, upcharge_total_cents, delivery_fee_cents
     FROM orders WHERE customer_id = ? ORDER BY week_of DESC LIMIT 12`,
    customer.id,
  );

  const invoices = await all(
    env.DB,
    `SELECT id, status, amount_paid_cents, amount_due_cents, period_start, hosted_invoice_url, created_at
     FROM invoices WHERE customer_id = ? ORDER BY created_at DESC LIMIT 12`,
    customer.id,
  );

  const selections = sub
    ? await all(
        env.DB,
        `SELECT week_of, meal_position, meal_name, qty
         FROM meal_selections WHERE subscription_id = ? AND qty > 0
         ORDER BY week_of DESC, meal_position ASC LIMIT 40`,
        sub.id,
      )
    : [];

  const totalSpentCents = invoices
    .filter((i) => i.status === 'paid')
    .reduce((s, i) => s + (i.amount_paid_cents || 0), 0);

  // Most recent week's selections = "this week".
  const latestWeek = selections.length ? selections[0].week_of : null;
  const thisWeek = selections.filter((s) => s.week_of === latestWeek);

  return ok({
    customer: {
      id: customer.id,
      email: customer.email,
      first_name: customer.first_name,
      last_name: customer.last_name,
      role: customer.role,
      is_owner: !!customer.is_owner,
      goal: customer.goal,
      sex: customer.sex,
      delivery_method: customer.delivery_method,
      delivery_zone: customer.delivery_zone,
      address: customer.address,
      city: customer.city,
      zip: customer.zip,
    },
    subscription: sub
      ? {
          status: sub.status,
          meals_per_week: sub.meals_per_week,
          tier_price_cents: sub.tier_price_cents,
          // Trustworthy per-meal rate from the public plan bands, by meal count. Legacy subs
          // (e.g. a flat $X/week line item) stored the WEEKLY total in tier_price_cents, which the
          // UI would otherwise multiply by meals again — derive from the band instead.
          per_meal_cents: tierForMeals(sub.meals_per_week)?.perMealCents ?? sub.tier_price_cents,
          current_period_end: sub.current_period_end,
          cancel_at_period_end: !!sub.cancel_at_period_end,
          coupon_code: sub.coupon_code,
          discount_active: !!sub.discount_active,
        }
      : null,
    this_week: thisWeek,
    meal_history: selections,
    orders,
    invoices,
    total_spent_cents: totalSpentCents,
  });
}
