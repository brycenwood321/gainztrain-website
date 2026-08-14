// POST /api/admin/comp-checkout — OWNER-ONLY. Generate a Stripe Checkout link that puts a specific
// customer onto a COMP subscription using an INTERNAL (is_public=0) coupon like STAFF100 / OWNERS100.
//
// WHY THIS EXISTS: checkout/create.js deliberately refuses any is_public=0 code ("a customer can't grant
// themselves a free-forever sub") — that guard is what closed the FAMFRIENDS15 leak and it must stay.
// So there was no way to put an employee on a comp without either making the code public (re-opening the
// leak) or hand-building the subscription in Stripe (which is how Angela became a legacy flat-line sub
// that broke her account page for months). This endpoint is the owner-authorized counterpart: the gate
// moves from WHICH CODE is used to WHO IS ASKING. A customer still cannot self-comp.
//
//   Body {
//     customer_id,                 // D1 customer id (required)
//     meals,                       // 6..16 (required)
//     coupon = 'STAFF100',         // must exist in D1 `coupons` AND be is_public=0
//     delivery_method?,            // 'pickup' | 'delivery' — defaults to whatever is on the customer
//     zip?, city?, address?        // optional; only used to fill in blanks on the customer row
//   }
//
// Returns { url } — an owner texts that link to the person. With a 100%-off coupon nothing is due, and
// `payment_method_collection: 'if_required'` means Stripe does not even ask them for a card.
//
// ⚠️ THE COMP MUST STAY A DISCOUNTED REAL PRICE, NEVER A $0 PRICE. The renewal invoice has to come out as
// subtotal > 0 zeroed by a discount, because that is the exact shape `invoiceCoversDelivery()` in
// payment-order-audit.js uses to tell a legitimate comp apart from a cancellation's final $0 invoice
// (both read status:'paid' + billing_reason:'subscription_cycle' — the DISCOUNT is the only
// discriminator). Swapping this to a $0 price or amount_off would make a comped employee register as
// unpaid food in the Saturday audit. See CLAUDE.md 2026-08-08 for the incident that established this.
import { ok, fail, readJson } from '../../_lib/respond.js';
import { one, run, nowIso } from '../../_lib/db.js';
import { requireOwner } from '../../_lib/admin.js';
import { stripe } from '../../_lib/stripe.js';
import { str } from '../../_lib/validate.js';
import { tierForMeals, ensureStripePrice, ensureDeliveryPrice, MIN_MEALS, MAX_MEALS } from '../../_lib/plans.js';

// Stripe statuses that mean "this person already has a plan" — same set checkout/create.js guards on.
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused']);

export async function onRequestPost(context) {
  const { env } = context;
  const denied = await requireOwner(context);
  if (denied) return denied;

  const body = await readJson(context.request);

  const customerId = str(body.customer_id).trim();
  if (!customerId) return fail(400, 'customer_required', 'customer_id is required.');
  const customer = await one(env.DB, `SELECT * FROM customers WHERE id = ?`, customerId);
  if (!customer) return fail(404, 'no_customer', 'No customer with that id.');

  const meals = Number(body.meals);
  const tier = tierForMeals(meals);
  if (!tier) return fail(400, 'invalid_meals', `meals must be ${MIN_MEALS}-${MAX_MEALS}.`);

  // ── Coupon gate ── must be a REAL row in our table AND internal-only. Public promo codes are refused
  // here on purpose: those have cap/expiry semantics that the normal /start checkout already enforces,
  // and routing them through an owner endpoint would quietly bypass that accounting.
  const code = (str(body.coupon).trim().toUpperCase() || 'STAFF100');
  const c = await one(env.DB, `SELECT code, is_public, percent_off, expires_at, cap FROM coupons WHERE code = ?`, code);
  if (!c) return fail(400, 'no_coupon', `${code} is not a coupon in this system.`);
  if (c.is_public) return fail(400, 'coupon_is_public', `${code} is a public promo code — comp codes must be is_public=0. Use the normal checkout for public codes.`);
  if (c.expires_at && new Date(c.expires_at) < new Date()) return fail(400, 'coupon_expired', `${code} has expired.`);

  // Respect the redemption cap using Stripe's own counter (the code IS the Stripe coupon id), same as
  // checkout/create.js. Soft-fail on a Stripe outage — Stripe enforces any native max_redemptions itself.
  try {
    const sc = await stripe(env, 'GET', `coupons/${encodeURIComponent(code)}`);
    if (sc && sc.valid === false) return fail(400, 'coupon_maxed', `${code} is no longer valid in Stripe.`);
    if (c.cap && sc && typeof sc.times_redeemed === 'number' && sc.times_redeemed >= c.cap) {
      return fail(400, 'coupon_maxed', `${code} has hit its cap of ${c.cap}.`);
    }
  } catch { /* Stripe unreachable — proceed */ }

  // ── Delivery ── default to what the customer already is. NOTE: no service-area gate here. That gate
  // exists to stop out-of-area STRANGERS signing up; an owner comping a named employee is not that.
  const deliveryMethod = body.delivery_method != null
    ? (str(body.delivery_method) === 'delivery' ? 'delivery' : 'pickup')
    : (customer.delivery_method === 'delivery' ? 'delivery' : 'pickup');

  const zip = str(body.zip).replace(/[^0-9]/g, '').slice(0, 5) || str(customer.zip || '');
  const city = str(body.city).trim().slice(0, 80) || str(customer.city || '');
  const address = str(body.address).trim().slice(0, 200) || str(customer.address || '');

  let zone = 0, feeCents = 0;
  if (deliveryMethod === 'delivery') {
    if (!address) return fail(400, 'address_required', 'A delivery comp needs a street address.');
    const z = zip ? await one(env.DB, `SELECT zone FROM zip_zone_map WHERE zip = ?`, zip) : null;
    if (!z) return fail(400, 'zone_unknown', 'That zip has no delivery zone — set the address first, or comp them as pickup.');
    zone = z.zone;
    const dz = await one(env.DB, `SELECT fee_cents FROM delivery_zones WHERE zone = ?`, zone);
    feeCents = dz?.fee_cents ?? 0;
  }

  try {
    // One Stripe customer per D1 customer — reuse before creating, or the double-billing guard below
    // can't see an existing subscription.
    let stripeCustomerId = customer.stripe_customer_id;
    let preexisting = !!stripeCustomerId;
    if (!stripeCustomerId) {
      try {
        const found = await stripe(env, 'GET', 'customers', { email: customer.email, limit: 1 });
        if (found.data && found.data.length) { stripeCustomerId = found.data[0].id; preexisting = true; }
      } catch { /* search failed — create a fresh customer below */ }
      if (!stripeCustomerId) {
        const sc = await stripe(env, 'POST', 'customers', {
          email: customer.email,
          name: [customer.first_name, customer.last_name].filter(Boolean).join(' ') || undefined,
          metadata: { d1_customer_id: customer.id },
        }, `gt_cust_${customer.id}`);
        stripeCustomerId = sc.id;
      }
      await run(env.DB, `UPDATE customers SET stripe_customer_id = ?, updated_at = ? WHERE id = ?`,
        stripeCustomerId, nowIso(), customer.id);
    }

    // ── Double-billing guard ── never stack a comp on top of a live plan. If someone already paying
    // should become comped, that is a coupon applied to their EXISTING subscription, not a second one.
    if (preexisting) {
      const subs = await stripe(env, 'GET', 'subscriptions', { customer: stripeCustomerId, status: 'all', limit: 20 });
      const live = (subs.data || []).find((s) => LIVE_STATUSES.has(s.status));
      if (live) {
        return fail(409, 'already_subscribed', `${customer.email} already has a live subscription (${live.id}) — comp that one instead of creating a second.`);
      }
    }

    const lineItems = [{ price: await ensureStripePrice(env, tier), quantity: meals }];
    if (deliveryMethod === 'delivery' && feeCents > 0) {
      lineItems.push({ price: await ensureDeliveryPrice(env, zone, feeCents), quantity: 1 });
    }

    const base = env.APP_BASE_URL || '';
    const session = await stripe(env, 'POST', 'checkout/sessions', {
      mode: 'subscription',
      customer: stripeCustomerId,
      line_items: lineItems,
      subscription_data: {
        metadata: {
          meals_per_week: String(meals), tier: tier.key, d1_customer_id: customer.id,
          delivery_method: deliveryMethod, delivery_zone: String(zone),
          promo: '',            // FUEL8-only field the webhook watches — a comp is not FUEL8
          comp: code,           // so a comped sub is identifiable in Stripe without reading discounts
        },
      },
      metadata: { d1_customer_id: customer.id, meals: String(meals), tier: tier.key, delivery_method: deliveryMethod, code },
      // 100% off means nothing is due now, so Stripe won't ask them for a card at all.
      payment_method_collection: 'if_required',
      discounts: [{ coupon: code }],
      success_url: `${base}/app/menu/?checkout=success`,
      cancel_url: `${base}/app/?checkout=cancel`,
    }, `gt_comp_${customer.id}_${meals}_${code}`);

    // Persist delivery choice + any blanks we filled, only after the session exists.
    await run(env.DB,
      `UPDATE customers SET delivery_method = ?, delivery_zone = ?, zip = COALESCE(NULLIF(?,''), zip),
         address = COALESCE(NULLIF(?,''), address), city = COALESCE(NULLIF(?,''), city), updated_at = ? WHERE id = ?`,
      deliveryMethod, zone, zip, address, city, nowIso(), customer.id);

    try {
      await run(env.DB, `INSERT INTO audit_log (at, actor, entity, action, detail_json) VALUES (?, 'owner', ?, 'comp_checkout', ?)`,
        nowIso(), `customer:${customer.id}`, JSON.stringify({ email: customer.email, meals, tier: tier.key, coupon: code, deliveryMethod, session: session.id }));
    } catch { /* non-fatal */ }

    return ok({
      url: session.url,
      email: customer.email,
      meals,
      tier: tier.key,
      coupon: code,
      percent_off: c.percent_off,
      delivery_method: deliveryMethod,
      weekly_value_cents: meals * tier.perMealCents + feeCents,
    });
  } catch (e) {
    return fail(502, 'comp_checkout_failed', String(e?.message || e).slice(0, 200));
  }
}
