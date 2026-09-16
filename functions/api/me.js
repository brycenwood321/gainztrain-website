// GET /api/me: the read-only "See My Account" view. Session-authenticated.
// Reads ONLY from D1 (the single source of truth). No writes, no billing actions.
//
// 2026-09-16 (app redesign, slice one): every addition below is ADDITIVE so the old /app pages keep
// working unchanged while /app/next is built beside them. What changed and why:
//   - this_week is the ORDERABLE week's picks (it used to be "the most recent week with any picks",
//     which showed a delivered week under the heading "This week" for most of the week).
//   - orders carry delivery_status / delivered_at / charge_status so Home can track the week.
//   - phone, open_invoices, pickup, next_charge, credits, orderable_week, delivery_week are new.
import { ok, fail } from '../_lib/respond.js';
import { all, one } from '../_lib/db.js';
import { getSessionCustomer } from '../_lib/auth.js';
import { tierForMeals, sizesEnabled, sizeForCustomer, perMealCentsFor } from '../_lib/plans.js';
import { orderableWeek } from '../_lib/menu.js';
import { pickupFor } from '../_lib/pickup.js';
import { pendingCredits } from '../_lib/credits.js';
import { nextChargeEstimate } from '../_lib/estimate.js';

// The Sunday on or after today in Mountain time: the week being delivered (or delivered today).
export function deliverySundayMT(now = new Date()) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  const p = {}; f.formatToParts(now).forEach((x) => { p[x.type] = x.value; });
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  const d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
  d.setUTCDate(d.getUTCDate() + ((7 - dow) % 7));
  return d.toISOString().slice(0, 10);
}

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
    `SELECT id, week_of, status, total_meals, upcharge_total_cents, delivery_fee_cents,
            delivery_status, delivered_at, charge_status
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
        `SELECT week_of, meal_position, meal_name, qty, upcharge_per_meal_cents
         FROM meal_selections WHERE subscription_id = ? AND qty > 0
         ORDER BY week_of DESC, meal_position ASC LIMIT 40`,
        sub.id,
      )
    : [];

  const totalSpentCents = invoices
    .filter((i) => i.status === 'paid')
    .reduce((s, i) => s + (i.amount_paid_cents || 0), 0);
  const openInvoices = invoices.filter((i) => i.status === 'open').length;

  const orderable = orderableWeek();
  const deliveryWeek = deliverySundayMT();
  const thisWeek = selections.filter((s) => s.week_of === orderable);
  const pastWeeks = selections.filter((s) => s.week_of < orderable).map((s) => s.week_of);
  const lastWeekOf = pastWeeks.length ? pastWeeks[0] : null;
  const lastWeek = lastWeekOf ? selections.filter((s) => s.week_of === lastWeekOf) : [];

  // Trustworthy per-meal rate from the public plan bands, by meal count. Legacy subs (a flat $X/week
  // line item) stored the WEEKLY total in tier_price_cents, which the UI would otherwise multiply by
  // meals again, so derive from the band instead.
  const perMealCents = sub
    ? (sizesEnabled(env)
        ? (perMealCentsFor(env, sizeForCustomer(customer).key, sub.meals_per_week) ?? sub.tier_price_cents)
        : (tierForMeals(sub.meals_per_week)?.perMealCents ?? sub.tier_price_cents))
    : null;

  // Next charge: what the Saturday lock will bill for the orderable week, as an estimate.
  let nextCharge = null; let credits = [];
  if (sub && ['active', 'trialing', 'past_due'].includes(sub.status)) {
    let feeCents = 0;
    if (customer.delivery_method === 'delivery' && customer.delivery_zone) {
      const dz = await one(env.DB, `SELECT fee_cents FROM delivery_zones WHERE zone = ?`, customer.delivery_zone);
      feeCents = dz?.fee_cents || 0;
    }
    const upcharge = thisWeek.reduce((s, r) => s + (r.qty || 0) * (r.upcharge_per_meal_cents || 0), 0);
    try { credits = await pendingCredits(env, sub.id); } catch { credits = []; }
    let creditMeals = credits.reduce((s, c) => s + (c.meals || 0), 0);
    // The live discount, the way Stripe applies it: a D1 coupon row is a percent off meals; FUEL8 is
    // not a D1 row (plans.js, a dynamic per-tier coupon) and is worth 2 free meals a week for 4 weeks.
    let discountPct = 0;
    if (sub.coupon_code && sub.discount_active) {
      if (String(sub.coupon_code).toUpperCase() === 'FUEL8') creditMeals += 2;
      else {
        const cp = await one(env.DB, `SELECT percent_off FROM coupons WHERE code = ?`, sub.coupon_code);
        discountPct = cp?.percent_off || 0;
      }
    }
    nextCharge = {
      date: sub.current_period_end,
      week_of: orderable,
      // A queued cancel stops the renewal at current_period_end, so a week after that date is never charged.
      will_charge: !(sub.cancel_at_period_end && sub.current_period_end && orderable > String(sub.current_period_end).slice(0, 10)),
      coupon: sub.coupon_code && sub.discount_active ? sub.coupon_code : null,
      ...nextChargeEstimate({ mealsPerWeek: sub.meals_per_week, perMealCents: perMealCents || 0, deliveryFeeCents: feeCents, upchargeCents: upcharge, pendingCreditMeals: creditMeals, discountPct }),
    };
  }

  const pk = pickupFor(deliveryWeek);

  return ok({
    customer: {
      id: customer.id,
      email: customer.email,
      first_name: customer.first_name,
      last_name: customer.last_name,
      phone: customer.phone || null,
      role: customer.role,
      is_owner: !!customer.is_owner,
      goal: customer.goal,
      sex: customer.sex,
      delivery_method: customer.delivery_method,
      delivery_zone: customer.delivery_zone,
      address: customer.address,
      city: customer.city,
      zip: customer.zip,
      // Sizes (Build 3): present only with the flag on, so the flag-off payload is unchanged.
      ...(sizesEnabled(env) ? { size_key: sizeForCustomer(customer).key } : {}),
    },
    subscription: sub
      ? {
          status: sub.status,
          meals_per_week: sub.meals_per_week,
          tier_price_cents: sub.tier_price_cents,
          per_meal_cents: perMealCents,
          current_period_end: sub.current_period_end,
          cancel_at_period_end: !!sub.cancel_at_period_end,
          coupon_code: sub.coupon_code,
          discount_active: !!sub.discount_active,
        }
      : null,
    orderable_week: orderable,
    delivery_week: deliveryWeek,
    this_week: thisWeek,
    last_week: lastWeek,
    meal_history: selections,
    orders,
    invoices,
    open_invoices: openInvoices,
    total_spent_cents: totalSpentCents,
    pickup: { windowLabel: pk.windowLabel, lengthLabel: pk.lengthLabel, address: pk.addressLine, addressShort: pk.addressLine.replace(', Suite B', '') },
    next_charge: nextCharge,
    credits: credits.map((c) => ({ kind: c.kind, meals: c.meals, status: 'pending' })),
  });
}
