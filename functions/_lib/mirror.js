// Stripe → D1 mirror logic. Shared by the live webhook (functions/api/stripe-webhook.js)
// and the one-shot backfill (functions/api/admin/backfill.js) so there is exactly ONE
// definition of "how a Stripe object becomes a D1 row." Money is integer cents.
import { one, run, nowIso } from './db.js';
import { randomToken } from './crypto.js';
import { stripe } from './stripe.js';

export async function audit(env, entity, action, detail) {
  try {
    await run(
      env.DB,
      `INSERT INTO audit_log (at, actor, entity, action, detail_json) VALUES (?, 'webhook:stripe', ?, ?, ?)`,
      nowIso(), entity, action, JSON.stringify(detail || {}),
    );
  } catch { /* audit must never break the mirror */ }
}

// Find (or create a stub for) the customer behind a Stripe customer id.
// On create we pull email/name/phone from Stripe so the row is usable immediately.
export async function ensureCustomer(env, stripeCustomerId) {
  if (!stripeCustomerId) return null;
  const found = await one(env.DB, `SELECT * FROM customers WHERE stripe_customer_id = ?`, stripeCustomerId);
  if (found) return found;

  let email = null, first = null, last = null, phone = null;
  try {
    const c = await stripe(env, 'GET', `customers/${stripeCustomerId}`);
    email = (c.email || '').toLowerCase() || null;
    phone = c.phone || null;
    const nm = (c.name || '').trim().split(/\s+/);
    first = nm[0] || null;
    last = nm.length > 1 ? nm.slice(1).join(' ') : null;
  } catch { /* offline/test — create a minimal stub keyed on the stripe id */ }

  // Email is UNIQUE + NOT NULL; synthesize a placeholder if Stripe gave us none.
  const safeEmail = email || `${stripeCustomerId}@stripe.local`;
  const existingByEmail = await one(env.DB, `SELECT * FROM customers WHERE email = ?`, safeEmail);
  if (existingByEmail) {
    // Link the stripe id onto an account that registered by email first.
    await run(env.DB, `UPDATE customers SET stripe_customer_id = ?, updated_at = ? WHERE id = ?`,
      stripeCustomerId, nowIso(), existingByEmail.id);
    return { ...existingByEmail, stripe_customer_id: stripeCustomerId };
  }

  const id = randomToken(16);
  const now = nowIso();
  await run(
    env.DB,
    `INSERT INTO customers (id, email, first_name, last_name, phone, role, stripe_customer_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'customer', ?, ?, ?)`,
    id, safeEmail, first, last, phone, stripeCustomerId, now, now,
  );
  await audit(env, `customer:${id}`, 'created_from_stripe', { stripeCustomerId, email: safeEmail });
  return await one(env.DB, `SELECT * FROM customers WHERE id = ?`, id);
}

// Best-effort meals-per-week from a subscription: metadata wins; else the
// recurring item with the largest quantity (delivery/zone items are qty 1).
export function deriveMealTier(sub) {
  const metaN = parseInt(sub?.metadata?.meals_per_week, 10);
  if (Number.isFinite(metaN) && metaN > 0) return { meals: metaN, unit: null };
  const items = sub?.items?.data || [];
  let best = null;
  for (const it of items) {
    const q = it.quantity || 0;
    if (!best || q > best.quantity) best = { quantity: q, unit: it.price?.unit_amount ?? null };
  }
  return { meals: best && best.quantity > 1 ? best.quantity : null, unit: best?.unit ?? null };
}

export async function mirrorSubscription(env, sub) {
  const customer = await ensureCustomer(env, sub.customer);
  if (!customer) return;

  const discount = (sub.discounts && sub.discounts.length) ? sub.discounts[0] : sub.discount;
  const couponCode = discount?.coupon?.id || discount?.coupon?.name || null;
  const discountActive = discount ? 1 : 0;
  const now = nowIso();
  const periodStart = sub.current_period_start ? new Date(sub.current_period_start * 1000).toISOString() : null;
  const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;

  const existing = await one(env.DB, `SELECT * FROM subscriptions WHERE stripe_subscription_id = ?`, sub.id);
  const { meals, unit } = deriveMealTier(sub);
  // Never clobber a known-good tier with a worse guess.
  const mealsPerWeek = meals ?? existing?.meals_per_week ?? 0;
  const tierPrice = unit ?? existing?.tier_price_cents ?? null;

  if (existing) {
    await run(
      env.DB,
      `UPDATE subscriptions SET status=?, meals_per_week=?, tier_price_cents=?, current_period_start=?,
         current_period_end=?, cancel_at_period_end=?, coupon_code=?, discount_active=?, updated_at=?
       WHERE stripe_subscription_id=?`,
      sub.status, mealsPerWeek, tierPrice, periodStart, periodEnd,
      sub.cancel_at_period_end ? 1 : 0, couponCode, discountActive, now, sub.id,
    );
    await audit(env, `subscription:${existing.id}`, `stripe_${sub.status}`,
      { stripeSubId: sub.id, status: sub.status, cancel_at_period_end: !!sub.cancel_at_period_end, couponCode });
  } else {
    const id = randomToken(16);
    await run(
      env.DB,
      `INSERT INTO subscriptions (id, customer_id, stripe_subscription_id, status, meals_per_week, tier_price_cents,
         current_period_start, current_period_end, cancel_at_period_end, coupon_code, discount_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, customer.id, sub.id, sub.status, mealsPerWeek, tierPrice,
      periodStart, periodEnd, sub.cancel_at_period_end ? 1 : 0, couponCode, discountActive, now, now,
    );
    await audit(env, `subscription:${id}`, 'created_from_stripe', { stripeSubId: sub.id, status: sub.status, mealsPerWeek });
  }
}

export async function mirrorInvoice(env, inv) {
  const customer = await ensureCustomer(env, inv.customer);
  const sub = inv.subscription
    ? await one(env.DB, `SELECT id FROM subscriptions WHERE stripe_subscription_id = ?`, inv.subscription)
    : null;
  const discountCents = (inv.total_discount_amounts || []).reduce((s, d) => s + (d.amount || 0), 0);

  await run(
    env.DB,
    `INSERT INTO invoices (id, customer_id, subscription_id, status, amount_due_cents, amount_paid_cents,
       subtotal_cents, discount_cents, period_start, period_end, hosted_invoice_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status=excluded.status, amount_due_cents=excluded.amount_due_cents,
       amount_paid_cents=excluded.amount_paid_cents, subtotal_cents=excluded.subtotal_cents,
       discount_cents=excluded.discount_cents, hosted_invoice_url=excluded.hosted_invoice_url`,
    inv.id, customer?.id || null, sub?.id || null, inv.status,
    inv.amount_due ?? null, inv.amount_paid ?? null, inv.subtotal ?? null, discountCents,
    inv.period_start ? new Date(inv.period_start * 1000).toISOString() : null,
    inv.period_end ? new Date(inv.period_end * 1000).toISOString() : null,
    inv.hosted_invoice_url || null, nowIso(),
  );
  await audit(env, `invoice:${inv.id}`, `stripe_${inv.status}`,
    { customerId: customer?.id, amount_paid_cents: inv.amount_paid, amount_due_cents: inv.amount_due });
}

export async function mirrorPayment(env, pi, status) {
  const customer = await ensureCustomer(env, pi.customer);
  await run(
    env.DB,
    `INSERT INTO payments (id, invoice_id, customer_id, amount_cents, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status=excluded.status, amount_cents=excluded.amount_cents`,
    pi.id, pi.invoice || null, customer?.id || null,
    pi.amount_received ?? pi.amount ?? null, status, nowIso(),
  );
  await audit(env, `payment:${pi.id}`, `stripe_${status}`, { amount: pi.amount_received ?? pi.amount });
}
