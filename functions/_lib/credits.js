// Meal credits applied to an EXISTING subscription at its next lock. Plan rev 4, 09-28 build.
//
// Why a separate path from coupons: a Stripe coupon is attached at Checkout, so it can only ever reach
// a brand-new subscription. The referrer already has one. A credit is a NEGATIVE invoice item put on
// this cycle's draft invoice in the same slot as the specialty upcharge (lock-week.js), before the
// draft is finalized and paid. Two rules from the referral map, both enforced here:
//   1. cap the credit at what is left on the draft, so Stripe never carries a negative balance forward;
//   2. attach BEFORE the charge, or it lands on next week's invoice.
// A settled invoice (Stripe charged before the lock) keeps the credit pending for the following week
// and writes an audit row, never a second charge or a refund.
import { all, run, nowIso } from './db.js';
import { stripe } from './stripe.js';
import { perMealCentsFor } from './plans.js';
import { randomToken } from './crypto.js';

export const CREDIT_KINDS = {
  referral_referrer: 'Referral thank-you',
  referral_referred: 'Referral welcome',
  week4_bonus: 'Week 4 bonus',
};

// Pure. The cents to credit for `meals` at `perMealCents`, never more than `remainingCents` (what is
// still owed on the draft after earlier credits), never negative.
export function creditAmountCents(meals, perMealCents, remainingCents) {
  const want = Math.max(0, Math.round((Number(meals) || 0) * (Number(perMealCents) || 0)));
  const cap = Math.max(0, Number(remainingCents) || 0);
  return Math.min(want, cap);
}

export async function grantCredit(env, { subscriptionId, customerId, kind, meals, refId = null }) {
  if (!CREDIT_KINDS[kind]) throw new Error(`grantCredit: unknown kind ${kind}`);
  const id = `cr_${randomToken(8)}`;
  await run(env.DB,
    `INSERT INTO subscription_credits (id, subscription_id, customer_id, kind, meals, ref_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`, id, subscriptionId, customerId, kind, meals, refId, nowIso());
  return id;
}

export async function pendingCredits(env, subscriptionId) {
  return all(env.DB,
    `SELECT id, kind, meals, ref_id FROM subscription_credits WHERE subscription_id = ? AND status = 'pending' ORDER BY created_at`,
    subscriptionId);
}

// Attach every pending credit for this sub to the draft. `sub` needs id, meals_per_week,
// stripe_customer_id, size_key; `draft` is the Stripe draft invoice (id, total). Returns a summary
// for the lock's log line. Non-fatal by design: a credit that fails to attach stays pending and is
// logged; it must never stop the base charge (same rule as the upcharge).
export async function applyCreditsToDraft(env, sub, weekOf, draft, auditRow) {
  const out = { applied: 0, cents: 0, skipped: 0 };
  if (!draft || !draft.id || !sub.stripe_customer_id) return out;
  const credits = await pendingCredits(env, sub.id);
  if (!credits.length) return out;
  const perMeal = perMealCentsFor(env, sub.size_key, sub.meals_per_week) || 0;
  // Cents still creditable this week: what is owed on the draft, but never more than this week's MEAL
  // charges. The draft total also carries the delivery fee and any specialty upcharge, and a credit is
  // meals off, not delivery off (code map 2026-09-14, cash shelf).
  const mealCharges = Math.max(0, Math.round(perMeal * (Number(sub.meals_per_week) || 0)));
  let remaining = Math.min(Number(draft.total) || 0, mealCharges);
  for (const cr of credits) {
    const cents = creditAmountCents(cr.meals, perMeal, remaining);
    if (cents <= 0) { out.skipped++; continue; }   // nothing left to credit against this week; stays pending
    const label = CREDIT_KINDS[cr.kind] || cr.kind;
    try {
      await stripe(env, 'POST', 'invoiceitems', {
        customer: sub.stripe_customer_id, invoice: draft.id, amount: -cents, currency: 'usd',
        description: `${label}: ${cr.meals} free meal${cr.meals === 1 ? '' : 's'}, week of ${weekOf}`,
      }, `gt_credit_${cr.id}_${draft.id}`);
      await run(env.DB,
        `UPDATE subscription_credits SET status='applied', applied_at=?, invoice_id=?, week_of=?, amount_cents=? WHERE id=? AND status='pending'`,
        nowIso(), draft.id, weekOf, cents, cr.id);
      remaining -= cents;
      out.applied++; out.cents += cents;
    } catch (e) {
      if (auditRow) await auditRow(env, `subscription:${sub.id}`, 'credit_attach_failed', { creditId: cr.id, kind: cr.kind, weekOf, cents, draftId: draft.id, error: String(e).slice(0, 160) });
    }
  }
  return out;
}
