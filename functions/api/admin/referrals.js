// GET /api/admin/referrals: the referral program in numbers. Admin-gated (ops dashboard, Monday email,
// the 30-day read). Board ruling 2026-09-14: the keep bar is 5 code-attributed new PAYING customers in
// 30 days (the plan's 2 was below the 2.6 a month GT already got from friends with no program), read on
// the 2026-10-18 lock. Secondary: referred customers who reached a SECOND paid week.
//
//   ?since=YYYY-MM-DD   window start for the attributed counts (default: 30 days ago)
//
// "code-attributed" means a referrals row exists (the friend came through a link or typed a code);
// "paying" means that friend has at least one order with charge_status = 'paid'.
import { ok } from '../../_lib/respond.js';
import { requireStaffOrAdmin } from '../../_lib/admin.js';
import { one, all } from '../../_lib/db.js';
import { REFERRAL_MEALS } from '../../_lib/referral.js';

export async function referralStats(env, sinceIso) {
  const codes = await one(env.DB, `SELECT COUNT(*) AS n FROM customers WHERE referral_code IS NOT NULL`);
  const byStatus = await all(env.DB, `SELECT status, COUNT(*) AS n FROM referrals GROUP BY status`);
  const creditsByStatus = await all(env.DB,
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(meals),0) AS meals, COALESCE(SUM(amount_cents),0) AS cents
       FROM subscription_credits WHERE kind = 'referral_referrer' GROUP BY status`);
  // Referred friends inside the window, and how far each got.
  const attributed = await all(env.DB,
    `SELECT r.id, r.code, r.status, r.created_at, r.credited_at,
            c.first_name AS friend, rc.first_name AS referrer,
            (SELECT COUNT(*) FROM orders o WHERE o.customer_id = r.referred_customer_id AND o.charge_status = 'paid') AS paid_weeks
       FROM referrals r
       JOIN customers c ON c.id = r.referred_customer_id
       LEFT JOIN customers rc ON rc.id = r.referrer_customer_id
      WHERE r.created_at >= ?
      ORDER BY r.created_at DESC`, sinceIso);
  const paying = attributed.filter((a) => a.paid_weeks >= 1).length;
  const secondWeek = attributed.filter((a) => a.paid_weeks >= 2).length;
  // Referred friends by the lock week their first paid order landed on (the plan reads a lock).
  const byLockWeek = await all(env.DB,
    `SELECT o.week_of, COUNT(DISTINCT r.referred_customer_id) AS n
       FROM referrals r JOIN orders o ON o.customer_id = r.referred_customer_id AND o.charge_status = 'paid'
      WHERE o.week_of = (SELECT MIN(o2.week_of) FROM orders o2 WHERE o2.customer_id = r.referred_customer_id AND o2.charge_status = 'paid')
      GROUP BY o.week_of ORDER BY o.week_of DESC LIMIT 12`);
  const status = {};
  for (const r of byStatus) status[r.status] = r.n;
  const credits = {};
  for (const r of creditsByStatus) credits[r.status] = { n: r.n, meals: r.meals, cents: r.cents };
  // Every customer who holds a code, with how their referrals are doing (the ops Marketing table).
  const base = env.APP_BASE_URL || 'https://gainztrainprep.com';
  const customers = await all(env.DB,
    `SELECT c.id, c.first_name, c.last_name, c.email, c.referral_code,
            (SELECT COUNT(*) FROM referrals r WHERE r.referrer_customer_id = c.id) AS friends_signed_up,
            (SELECT COUNT(*) FROM referrals r WHERE r.referrer_customer_id = c.id AND r.status = 'credited') AS friends_paid,
            (SELECT COALESCE(SUM(meals),0) FROM subscription_credits sc WHERE sc.customer_id = c.id AND sc.kind = 'referral_referrer' AND sc.status = 'pending') AS meals_pending,
            (SELECT COALESCE(SUM(meals),0) FROM subscription_credits sc WHERE sc.customer_id = c.id AND sc.kind = 'referral_referrer' AND sc.status = 'applied') AS meals_applied,
            (SELECT s.status FROM subscriptions s WHERE s.customer_id = c.id ORDER BY (s.status IN ('active','trialing','past_due','paused')) DESC, s.created_at DESC LIMIT 1) AS sub_status
       FROM customers c
      WHERE c.referral_code IS NOT NULL
      ORDER BY friends_paid DESC, friends_signed_up DESC, c.first_name`);
  return {
    meals_per_referral: REFERRAL_MEALS,
    codes_issued: codes?.n || 0,
    referrals_by_status: status,
    credits_by_status: credits,
    window: { since: sinceIso, attributed: attributed.length, paying, second_paid_week: secondWeek, bar: 5 },
    first_paid_by_lock_week: byLockWeek,
    attributed,
    customers: customers.map((c) => ({ ...c, link: `${base}/start/?ref=${encodeURIComponent(c.referral_code)}` })),
  };
}

export async function onRequestGet(context) {
  const denied = await requireStaffOrAdmin(context);
  if (denied) return denied;
  const { env, request } = context;
  const sinceParam = new URL(request.url).searchParams.get('since') || '';
  const since = /^\d{4}-\d{2}-\d{2}$/.test(sinceParam)
    ? `${sinceParam}T00:00:00.000Z`
    : new Date(Date.now() - 30 * 86400000).toISOString();
  return ok(await referralStats(env, since));
}
