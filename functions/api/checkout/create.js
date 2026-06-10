// POST /api/checkout/create — start a subscription via Stripe hosted Checkout.
// Session-gated: the customer must already have an account (pick plan → create account → pay).
// Body: { meals: 6..16, delivery_method: 'pickup'|'delivery', address?, city?, zip? }
// Returns { url } to redirect the browser to Stripe.
//
// Stamps meals_per_week into the subscription (line quantity AND metadata) so the webhook records
// the meal tier with zero GHL dependency. Delivery is a second line item priced by zip → zone fee.
//
// DOUBLE-BILLING GUARD: refuses to start a new subscription if the customer already has a live one
// (checks Stripe directly — authoritative even before the webhook is registered). Stripe idempotency
// keys make rapid double-clicks/retries collapse to one customer/session.
import { ok, fail, readJson } from '../../_lib/respond.js';
import { one, run, nowIso } from '../../_lib/db.js';
import { getSessionCustomer } from '../../_lib/auth.js';
import { stripe } from '../../_lib/stripe.js';
import { str } from '../../_lib/validate.js';
import { tierForMeals, ensureStripePrice, ensureDeliveryPrice, MIN_MEALS, MAX_MEALS } from '../../_lib/plans.js';

// Stripe statuses that mean "this person already has a plan" — block a second subscription.
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused']);

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = await getSessionCustomer(context);
  if (!auth) return fail(401, 'not_authenticated', 'Create an account first, then choose your plan.');
  const { customer } = auth;

  const body = await readJson(request);
  const meals = Number(body.meals);
  const tier = tierForMeals(meals);
  if (!tier) return fail(400, 'invalid_meals', `Choose between ${MIN_MEALS} and ${MAX_MEALS} meals per week.`);

  // Optional promo code: must be a PUBLIC (customer-facing) coupon in our table, not expired.
  // Internal comps like OWNERS100 (is_public=0) are blocked here — a customer can't grant themselves
  // a free-forever sub. The code IS the Stripe coupon id; we apply it directly to the Checkout Session.
  const code = str(body.code).trim().toUpperCase();
  if (code) {
    const c = await one(env.DB, `SELECT code, is_public, expires_at FROM coupons WHERE code = ?`, code);
    if (!c || !c.is_public) return fail(400, 'invalid_code', "That promo code isn't valid.");
    if (c.expires_at && new Date(c.expires_at) < new Date()) return fail(400, 'code_expired', 'That promo code has expired.');
  }

  const deliveryMethod = str(body.delivery_method) === 'delivery' ? 'delivery' : 'pickup';

  // SERVICE-AREA GATE: Gainz Train only serves specific Utah zips (zip_zone_map). Require a SERVED zip
  // for BOTH pickup and delivery — this is what stops out-of-area / out-of-state people from signing up.
  let zone = 0, feeCents = 0, address = '', city = '';
  const zip = str(body.zip).replace(/[^0-9]/g, '').slice(0, 5);
  if (zip.length !== 5) return fail(400, 'zip_required', 'Enter your 5-digit zip code.');
  const z = await one(env.DB, `SELECT zone FROM zip_zone_map WHERE zip = ?`, zip);
  if (!z) return fail(400, 'out_of_area', "Sorry — we don't serve your area yet. Gainz Train is Utah-only for now.");
  if (deliveryMethod === 'delivery') {
    address = str(body.address).trim().slice(0, 200);
    city = str(body.city).trim().slice(0, 80);
    if (!address) return fail(400, 'address_required', 'Enter your delivery address.');
    zone = z.zone;
    const dz = await one(env.DB, `SELECT fee_cents FROM delivery_zones WHERE zone = ?`, zone);
    if (!dz) return fail(500, 'zone_misconfigured', 'Delivery for your area is being set up — choose pickup for now.');
    feeCents = dz.fee_cents ?? 0;
  }
  // pickup: zone stays 0 + fee 0, but the served-zip check above gated them in.

  try {
    // One Stripe customer per D1 customer. Idempotency key prevents a double-click from making two.
    let stripeCustomerId = customer.stripe_customer_id;
    let preexisting = !!stripeCustomerId;
    if (!stripeCustomerId) {
      // Reuse an existing Stripe customer with this email (e.g. a legacy GHL-funnel customer who signs
      // up at /start) instead of spinning up a parallel customer — otherwise the double-billing guard
      // below can't see their existing sub and they get charged twice.
      try {
        const found = await stripe(env, 'GET', 'customers', { email: customer.email, limit: 1 });
        if (found.data && found.data.length) { stripeCustomerId = found.data[0].id; preexisting = true; }
      } catch { /* search failed — fall through to create a fresh customer */ }
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

    // ── Double-billing guard ── refuse if they already have a live subscription.
    // Stripe is authoritative (D1 lags the async webhook, which may not even be registered yet).
    if (preexisting) {
      const subs = await stripe(env, 'GET', 'subscriptions', { customer: stripeCustomerId, status: 'all', limit: 20 });
      const live = (subs.data || []).find((s) => LIVE_STATUSES.has(s.status));
      if (live) {
        return fail(409, 'already_subscribed', "You already have an active plan — manage it from your account.");
      }
    }

    const lineItems = [{ price: await ensureStripePrice(env, tier), quantity: meals }];
    if (deliveryMethod === 'delivery' && feeCents > 0) {
      lineItems.push({ price: await ensureDeliveryPrice(env, zone, feeCents), quantity: 1 });
    }

    const base = env.APP_BASE_URL || '';
    const sessionParams = {
      mode: 'subscription',
      customer: stripeCustomerId,
      line_items: lineItems,
      subscription_data: {
        metadata: {
          meals_per_week: String(meals), tier: tier.key, d1_customer_id: customer.id,
          delivery_method: deliveryMethod, delivery_zone: String(zone),
        },
      },
      metadata: { d1_customer_id: customer.id, meals: String(meals), tier: tier.key, delivery_method: deliveryMethod, code: code || '' },
      // Don't force a card when nothing is due now (e.g. a 100%-off plan checks out at $0).
      payment_method_collection: 'if_required',
      success_url: `${base}/app/menu/?checkout=success`,
      cancel_url: `${base}/start/?checkout=cancel`,
    };
    // A validated code applies its coupon directly; otherwise let Stripe accept promotion codes.
    if (code) sessionParams.discounts = [{ coupon: code }];
    else sessionParams.allow_promotion_codes = true;

    const session = await stripe(env, 'POST', 'checkout/sessions', sessionParams,
      `gt_checkout_${customer.id}_${meals}_${deliveryMethod}_${zone}_${code}`);

    // Persist the delivery choice only AFTER the session is created (not on a validation failure).
    await run(env.DB,
      `UPDATE customers SET delivery_method = ?, delivery_zone = ?, zip = COALESCE(NULLIF(?,''), zip),
         address = COALESCE(NULLIF(?,''), address), city = COALESCE(NULLIF(?,''), city), updated_at = ? WHERE id = ?`,
      deliveryMethod, zone, zip, address, city, nowIso(), customer.id);

    return ok({ url: session.url, tier: tier.key, meals, delivery_method: deliveryMethod, delivery_fee_cents: feeCents });
  } catch (e) {
    return fail(502, 'checkout_failed', String(e?.message || e).slice(0, 200));
  }
}
