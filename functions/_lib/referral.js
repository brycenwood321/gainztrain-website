// Referrals. Board ruling 2026-09-14 (offers, mealprep, cash shelves) with Brycen's timing call 09-15.
//
// Flow: a customer's code (customers.referral_code, e.g. ZAC-7K2Q) arrives as /start/?ref=CODE (its
// own field at checkout, NOT the promo box) or is typed into the promo box. checkout/create.js records
// a PENDING referral row and gives the friend FUEL8 on top while the switch is on: the friend's reward
// IS the live signup offer. The referral attaches no coupon of its own. When the friend's FIRST order
// is paid at a lock, the REFERRER is granted REFERRAL_MEALS off their next invoice on the credit path
// (credits.js): a negative invoice item, money off, not extra food. The friend gets no second credit.
//
// Why the referral left the promo box: one box takes one code, so a friend on a referral link had
// FUEL8 overwritten (8 meals traded for 2) and a friend who typed FUEL8 earned the referrer nothing.
//
// Rule: keep if 5 code-attributed new paying customers in 30 days (the plan's 2 was below the 2.6 a
// month GT already got from friends with no program).
import { one, all, run, nowIso } from './db.js';
import { grantCredit } from './credits.js';
import { ownerNotify } from './owner_notify.js';

export const REFERRAL_MEALS = 4;
export const FRIEND_OFFER = '8 free meals, 2 free every week for 4 weeks';   // FUEL8, see plans.js fuel8On
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
// Grants the referrer's credit the first time this customer's order is paid, once. Never throws.
// A referrer with no LIVE subscription (active, trialing, past_due or paused) is not granted anything:
// the row stays pending and is re-checked at this friend's next paid lock, so a referrer who comes
// back still collects and a credit is never parked on a cancelled subscription id nobody will bill
// again (Perkins, tested true 2026-09-14: credits.js only ever attaches to a draft).
export async function creditReferralIfEarned(env, customerId, sub, weekOf) {
  try {
    const ref = await one(env.DB, `SELECT * FROM referrals WHERE referred_customer_id = ? AND status = 'pending'`, customerId);
    if (!ref) return null;
    const paidOrders = await one(env.DB,
      `SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? AND charge_status = 'paid'`, customerId);
    if ((paidOrders?.n || 0) < 1) return null;   // the lock writes charge_status before calling this
    const referrerSub = await one(env.DB,
      `SELECT id FROM subscriptions WHERE customer_id = ? AND status IN ('active','trialing','past_due','paused') ORDER BY created_at DESC LIMIT 1`,
      ref.referrer_customer_id);
    if (!referrerSub) {
      try {
        await run(env.DB, `INSERT INTO audit_log (at, actor, entity, action, detail_json) VALUES (?, 'lock', ?, 'referral_held_referrer_inactive', ?)`,
          nowIso(), `customer:${ref.referrer_customer_id}`, JSON.stringify({ referral_id: ref.id, referred_customer_id: customerId, weekOf }));
      } catch { /* audit only */ }
      return null;
    }
    const a = await grantCredit(env, { subscriptionId: referrerSub.id, customerId: ref.referrer_customer_id, kind: 'referral_referrer', meals: REFERRAL_MEALS, refId: ref.id });
    await run(env.DB, `UPDATE referrals SET status='credited', credited_at=? WHERE id = ?`, nowIso(), ref.id);
    const names = await all(env.DB, `SELECT id, first_name, email FROM customers WHERE id IN (?, ?)`, ref.referrer_customer_id, customerId);
    const nm = (id) => { const r = names.find((x) => x.id === id); return r ? (r.first_name || r.email) : id; };
    await ownerNotify(env, 'owner_referral_credited',
      `Referral paid off: ${nm(customerId)} (referred by ${nm(ref.referrer_customer_id)}, code ${ref.code}) paid week ${weekOf}; ${REFERRAL_MEALS} free meals queued for ${nm(ref.referrer_customer_id)} at their next lock`,
      { entity: `customer:${customerId}`, referral_id: ref.id, credits: [a] });
    return { referral: ref.id, credits: [a] };
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
    code, meals: REFERRAL_MEALS, friend_offer: FRIEND_OFFER,
    link: code ? referralLink(env, code) : null,
    share_text: code ? shareText(env, code) : null,
    referrals: rows.map((r) => ({ first_name: r.first_name, status: r.status, created_at: r.created_at, credited_at: r.credited_at })),
    credits,
  };
}

export function referralLink(env, code) {
  const base = env.APP_BASE_URL || 'https://gainztrainprep.com';
  return `${base}/start/?ref=${encodeURIComponent(code)}`;
}

// One sentence, the whole pitch (offers shelf: name the offer so the right person shows up).
export function shareText(env, code) {
  return `Try Gainz Train with me: ${referralLink(env, code)} gets you 8 free meals (2 a week for 4 weeks) and I get 4. Code ${code}.`;
}

// What a customer message needs to carry the ask: their code and link. Mints the code on first use.
// Never throws, so a notify call site can spread it without a guard: `{ weekOf, ...(await referralData(env, cust)) }`.
export async function referralData(env, customer) {
  try {
    const row = customer.referral_code ? customer : await one(env.DB, `SELECT id, first_name, referral_code FROM customers WHERE id = ?`, customer.id);
    const code = row ? await ensureReferralCode(env, row) : null;
    if (!code) return {};
    return { referral_code: code, referral_link: referralLink(env, code), referral_meals: REFERRAL_MEALS };
  } catch {
    return {};
  }
}
