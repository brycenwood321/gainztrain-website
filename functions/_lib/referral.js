// Referrals, give 2 get 2. Plan rev 4, 09-28 build.
//
// Flow: a customer's code (customers.referral_code, e.g. ZAC-7K2Q) is typed into the promo box on
// /start or arrives as /start/?ref=CODE. checkout/create.js records a PENDING referral row (no Stripe
// coupon, so the Full Week Guarantee still applies to the new customer's first order and terms 5 is
// not tripped). When the new customer's FIRST order is paid at a lock, two credits are granted on the
// credit path (credits.js): 2 meals to the referrer's subscription, 2 meals to the new customer's
// subscription, each applied at that subscription's next lock. So the referred customer eats their
// free meals in week two, which is also the week the plan most needs them to still be here.
//
// Rule: keep if 2 paying customers redeem in 30 days (plan, "Rules, written before the data").
import { one, all, run, nowIso } from './db.js';
import { grantCredit } from './credits.js';
import { ownerNotify } from './owner_notify.js';

export const REFERRAL_MEALS = 2;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O/1/I

export function referralCodeFor(firstName, rand = Math.random) {
  const stem = String(firstName || 'GT').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6) || 'GT';
  let tail = '';
  for (let i = 0; i < 4; i++) tail += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return `${stem}-${tail}`;
}

export function isReferralShaped(code) {
  return /^[A-Z]{2,6}-[A-HJ-NP-Z2-9]{4}$/.test(String(code || '').toUpperCase());
}

export async function ensureReferralCode(env, customer) {
  if (customer.referral_code) return customer.referral_code;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = referralCodeFor(customer.first_name);
    try {
      await run(env.DB, `UPDATE customers SET referral_code = ?, updated_at = ? WHERE id = ? AND referral_code IS NULL`, code, nowIso(), customer.id);
      const row = await one(env.DB, `SELECT referral_code FROM customers WHERE id = ?`, customer.id);
      if (row?.referral_code) return row.referral_code;
    } catch { /* unique clash, try again */ }
  }
  return null;
}

// The referrer for a code, or null. A code only works while its owner has a plan that is live or
// paused (a cancelled customer cannot keep earning credits they will never use).
export async function lookupReferralCode(env, code) {
  const c = String(code || '').trim().toUpperCase();
  if (!isReferralShaped(c)) return null;
  return one(env.DB,
    `SELECT c.id, c.first_name, c.email FROM customers c
      WHERE c.referral_code = ?
        AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.customer_id = c.id AND s.status IN ('active','trialing','past_due','paused'))`, c);
}

// Called by checkout/create.js after the Checkout Session exists. Idempotent per referred customer.
// Refuses self-referral and anyone who has already paid us (new customers only).
export async function recordReferral(env, referrer, referredCustomerId, code) {
  if (!referrer || referrer.id === referredCustomerId) return { ok: false, reason: 'self' };
  const paidBefore = await one(env.DB, `SELECT 1 AS x FROM invoices WHERE customer_id = ? AND status = 'paid' LIMIT 1`, referredCustomerId);
  if (paidBefore) return { ok: false, reason: 'not_new' };
  try {
    await run(env.DB,
      `INSERT OR IGNORE INTO referrals (id, code, referrer_customer_id, referred_customer_id, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`, `rf_${crypto.randomUUID().slice(0, 12)}`, code, referrer.id, referredCustomerId, nowIso());
    return { ok: true };
  } catch (e) { return { ok: false, reason: String(e).slice(0, 80) }; }
}

// Called by lock-week after a PAID outcome for `sub` (an app-origin subscription of `customerId`).
// Grants both credits the first time this customer's order is paid, once. Never throws.
export async function creditReferralIfEarned(env, customerId, sub, weekOf) {
  try {
    const ref = await one(env.DB, `SELECT * FROM referrals WHERE referred_customer_id = ? AND status = 'pending'`, customerId);
    if (!ref) return null;
    const paidOrders = await one(env.DB,
      `SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? AND charge_status = 'paid'`, customerId);
    if ((paidOrders?.n || 0) < 1) return null;   // the lock writes charge_status before calling this
    const referrerSub = await one(env.DB,
      `SELECT id FROM subscriptions WHERE customer_id = ? ORDER BY (status IN ('active','trialing','past_due','paused')) DESC, created_at DESC LIMIT 1`,
      ref.referrer_customer_id);
    if (!referrerSub) {
      await run(env.DB, `UPDATE referrals SET status='void', void_reason='referrer_has_no_subscription' WHERE id = ?`, ref.id);
      return null;
    }
    const a = await grantCredit(env, { subscriptionId: referrerSub.id, customerId: ref.referrer_customer_id, kind: 'referral_referrer', meals: REFERRAL_MEALS, refId: ref.id });
    const b = await grantCredit(env, { subscriptionId: sub.id, customerId, kind: 'referral_referred', meals: REFERRAL_MEALS, refId: ref.id });
    await run(env.DB, `UPDATE referrals SET status='credited', credited_at=? WHERE id = ?`, nowIso(), ref.id);
    const names = await all(env.DB, `SELECT id, first_name, email FROM customers WHERE id IN (?, ?)`, ref.referrer_customer_id, customerId);
    const nm = (id) => { const r = names.find((x) => x.id === id); return r ? (r.first_name || r.email) : id; };
    await ownerNotify(env, 'owner_referral_credited',
      `Referral paid off: ${nm(customerId)} (referred by ${nm(ref.referrer_customer_id)}, code ${ref.code}) paid week ${weekOf}; ${REFERRAL_MEALS} free meals queued for each at their next lock`,
      { entity: `customer:${customerId}`, referral_id: ref.id, credits: [a, b] });
    return { referral: ref.id, credits: [a, b] };
  } catch (e) {
    try { await ownerNotify(env, 'owner_referral_failed', `Referral credit FAILED for customer ${customerId} week ${weekOf}: ${String(e).slice(0, 120)}`, { entity: `customer:${customerId}` }); } catch { /* nothing */ }
    return null;
  }
}

// What the account page shows: code, link, share text and how each referral is doing.
export async function referralSummary(env, customer) {
  const code = await ensureReferralCode(env, customer);
  const base = env.APP_BASE_URL || 'https://gainztrainprep.com';
  const rows = await all(env.DB,
    `SELECT r.status, r.created_at, r.credited_at, c.first_name FROM referrals r JOIN customers c ON c.id = r.referred_customer_id
      WHERE r.referrer_customer_id = ? ORDER BY r.created_at DESC LIMIT 20`, customer.id);
  const credits = await all(env.DB,
    `SELECT kind, meals, status, week_of FROM subscription_credits WHERE customer_id = ? ORDER BY created_at DESC LIMIT 20`, customer.id);
  return {
    code, meals: REFERRAL_MEALS,
    link: code ? `${base}/start/?ref=${encodeURIComponent(code)}` : null,
    share_text: code ? `Try Gainz Train with me. Use my code ${code} at ${base}/start/?ref=${code} and we both get ${REFERRAL_MEALS} free meals.` : null,
    referrals: rows.map((r) => ({ first_name: r.first_name, status: r.status, created_at: r.created_at, credited_at: r.credited_at })),
    credits,
  };
}
