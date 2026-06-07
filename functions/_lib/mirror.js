// Stripe → D1 mirror logic. Shared by the live webhook (functions/api/stripe-webhook.js)
// and the one-shot backfill (functions/api/admin/backfill.js) so there is exactly ONE
// definition of "how a Stripe object becomes a D1 row." Money is integer cents.
//
// Hardening (Phase 0 bug hunt):
//  - mirrorSubscription re-fetches the LIVE subscription from Stripe before writing, so
//    out-of-order / stale webhook payloads can't corrupt status (a 'canceled' can't revert
//    to 'active'). The webhook just says "this sub changed" — we read the current truth.
//  - All writes are idempotent upserts (ON CONFLICT), so retries + concurrent events converge
//    instead of throwing.
//  - Known-good fields (meals_per_week, tier_price, coupon_code) are never clobbered by a
//    sparse payload — they fall back to the existing value.
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

// Find (or create) the customer behind a Stripe customer id. Idempotent: concurrent
// inserts converge via ON CONFLICT instead of throwing. Upgrades an earlier @stripe.local
// stub to the real email once Stripe becomes reachable.
export async function ensureCustomer(env, stripeCustomerId) {
  if (!stripeCustomerId) return null;

  let email = null, first = null, last = null, phone = null, fetched = false;
  try {
    const c = await stripe(env, 'GET', `customers/${stripeCustomerId}`);
    email = (c.email || '').toLowerCase() || null;
    phone = c.phone || null;
    const nm = (c.name || '').trim().split(/\s+/).filter(Boolean);
    first = nm[0] || null;
    last = nm.length > 1 ? nm.slice(1).join(' ') : null;
    fetched = true;
  } catch { /* offline/test — fall back to a stub keyed on the stripe id */ }

  const existing = await one(env.DB, `SELECT * FROM customers WHERE stripe_customer_id = ?`, stripeCustomerId);
  if (existing) {
    // Upgrade a stub (@stripe.local) to the real email now that Stripe is reachable — only if
    // no other customer already owns that email (avoid a UNIQUE collision / accidental merge).
    if (fetched && email && existing.email.endsWith('@stripe.local') && existing.email !== email) {
      const clash = await one(env.DB, `SELECT id FROM customers WHERE email = ? AND id <> ?`, email, existing.id);
      if (!clash) {
        await run(env.DB, `UPDATE customers SET email = ?, first_name = COALESCE(first_name, ?), last_name = COALESCE(last_name, ?), phone = COALESCE(phone, ?), updated_at = ? WHERE id = ?`,
          email, first, last, phone, nowIso(), existing.id);
        return await one(env.DB, `SELECT * FROM customers WHERE id = ?`, existing.id);
      }
    }
    return existing;
  }

  // Email is UNIQUE + NOT NULL; synthesize a placeholder if Stripe gave us none.
  const safeEmail = email || `${stripeCustomerId}@stripe.local`;
  const id = randomToken(16);
  const now = nowIso();
  // Upsert by email: links the stripe id onto an account that registered by email first,
  // and converges if two events insert the same stub concurrently.
  await run(
    env.DB,
    `INSERT INTO customers (id, email, first_name, last_name, phone, role, stripe_customer_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'customer', ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       stripe_customer_id = COALESCE(customers.stripe_customer_id, excluded.stripe_customer_id),
       first_name = COALESCE(customers.first_name, excluded.first_name),
       last_name  = COALESCE(customers.last_name, excluded.last_name),
       phone      = COALESCE(customers.phone, excluded.phone),
       updated_at = excluded.updated_at`,
    id, safeEmail, first, last, phone, stripeCustomerId, now, now,
  );
  const row = await one(env.DB, `SELECT * FROM customers WHERE email = ?`, safeEmail);
  if (row && row.id === id) await audit(env, `customer:${id}`, 'created_from_stripe', { stripeCustomerId, email: safeEmail });
  return row;
}

// Best-effort meals-per-week: subscription metadata wins; else the recurring item with the
// largest quantity (delivery/zone items are qty 1). NOTE: GT currently encodes the tier in a
// GHL field, not Stripe — so this often returns null and we keep the existing value. The GHL
// enrichment + future app-checkout (metadata.meals_per_week) are the real sources.
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

export async function mirrorSubscription(env, subInput) {
  const stripeSubId = typeof subInput === 'string' ? subInput : subInput?.id;
  if (!stripeSubId) return;

  // Read the LIVE subscription (with the coupon expanded) so out-of-order / stale webhook
  // payloads can't write old state. Fall back to the delivered payload only if the fetch fails.
  let sub = (typeof subInput === 'object' && subInput) || {};
  try {
    sub = await stripe(env, 'GET', `subscriptions/${stripeSubId}`, { 'expand[]': 'discounts.coupon' });
  } catch { /* canceled/unreachable — use the payload we were handed */ }

  const customer = await ensureCustomer(env, sub.customer);
  if (!customer) return;

  const discount = (sub.discounts && sub.discounts.length) ? sub.discounts[0] : sub.discount;
  const couponCode = discount?.coupon?.id || discount?.coupon?.name || (typeof discount?.coupon === 'string' ? discount.coupon : null);
  const hasDiscount = !!discount;
  const now = nowIso();
  const periodStart = sub.current_period_start ? new Date(sub.current_period_start * 1000).toISOString() : null;
  const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;

  const existing = await one(env.DB, `SELECT * FROM subscriptions WHERE stripe_subscription_id = ?`, stripeSubId);
  const { meals, unit } = deriveMealTier(sub);
  // Never clobber a known-good value with a worse guess.
  const mealsPerWeek = meals ?? existing?.meals_per_week ?? 0;
  const tierPrice = unit ?? existing?.tier_price_cents ?? null;
  const finalCoupon = couponCode ?? existing?.coupon_code ?? null;
  // Stripe keeps a paused sub's status as 'active' with pause_collection set — derive 'paused' from
  // that, so a webhook re-fetch can't silently un-pause the customer in D1.
  const isPaused = !!(sub.pause_collection && sub.pause_collection.behavior);
  const status = isPaused ? 'paused' : (sub.status || existing?.status || 'incomplete');

  const id = existing?.id || randomToken(16);
  await run(
    env.DB,
    `INSERT INTO subscriptions (id, customer_id, stripe_subscription_id, status, meals_per_week, tier_price_cents,
       current_period_start, current_period_end, cancel_at_period_end, coupon_code, discount_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(stripe_subscription_id) DO UPDATE SET
       customer_id = excluded.customer_id,
       status = excluded.status,
       meals_per_week = excluded.meals_per_week,
       tier_price_cents = excluded.tier_price_cents,
       current_period_start = excluded.current_period_start,
       current_period_end = excluded.current_period_end,
       cancel_at_period_end = excluded.cancel_at_period_end,
       coupon_code = excluded.coupon_code,
       discount_active = excluded.discount_active,
       updated_at = excluded.updated_at`,
    id, customer.id, stripeSubId, status, mealsPerWeek, tierPrice,
    periodStart, periodEnd, sub.cancel_at_period_end ? 1 : 0, finalCoupon, hasDiscount ? 1 : 0, now, now,
  );
  await audit(env, `subscription:${id}`, `stripe_${status}`,
    { stripeSubId, status, paused: isPaused, cancel_at_period_end: !!sub.cancel_at_period_end, couponCode: finalCoupon });
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
       discount_cents=excluded.discount_cents, hosted_invoice_url=excluded.hosted_invoice_url,
       customer_id=COALESCE(invoices.customer_id, excluded.customer_id),
       subscription_id=COALESCE(invoices.subscription_id, excluded.subscription_id)`,
    inv.id, customer?.id || null, sub?.id || null, inv.status,
    inv.amount_due ?? null, inv.amount_paid ?? null, inv.subtotal ?? null, discountCents,
    inv.period_start ? new Date(inv.period_start * 1000).toISOString() : null,
    inv.period_end ? new Date(inv.period_end * 1000).toISOString() : null,
    inv.hosted_invoice_url || null, nowIso(),
  );
  await audit(env, `invoice:${inv.id}`, `stripe_${inv.status}`,
    { customerId: customer?.id, amount_paid_cents: inv.amount_paid, amount_due_cents: inv.amount_due });
}

// Records a payment OR a refund as its OWN row (refunds use a distinct id + negative amount),
// so a refund never overwrites/erases the original charge.
export async function mirrorPayment(env, { id, invoice, customer, amount, status }) {
  const cust = await ensureCustomer(env, customer);
  // Only link the invoice if it's already mirrored — a payment event can arrive before its
  // invoice event (FK would otherwise fail). A later invoice.* event backfills the link is N/A,
  // so we re-link opportunistically: if the invoice shows up later the COALESCE keeps our value,
  // but we set it now only when present.
  const invId = invoice
    ? (await one(env.DB, `SELECT id FROM invoices WHERE id = ?`, invoice))?.id || null
    : null;
  await run(
    env.DB,
    `INSERT INTO payments (id, invoice_id, customer_id, amount_cents, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status=excluded.status, amount_cents=excluded.amount_cents,
       invoice_id=COALESCE(payments.invoice_id, excluded.invoice_id),
       customer_id=COALESCE(payments.customer_id, excluded.customer_id)`,
    id, invId, cust?.id || null, amount ?? null, status, nowIso(),
  );
  await audit(env, `payment:${id}`, `stripe_${status}`, { amount });
}
