// GET /api/admin/attribution — the Phase 1 marketing "money query" (GT_MARKETING_PLAN_2026-07-08 §6):
// source → signups → paying customers → revenue, from three angles:
//   by_self_reported : the required "how did you hear about us?" answer (catches dark social)
//   by_utm           : first-touch UTM source, falling back to ad click-ids (gclid/fbclid)
//   cohort_by_coupon : retention per offer code — the Bernstein/HelloFresh lesson made queryable.
//                      weeks_avg = avg locked/prepped weekly orders per customer; retained_4wk counts
//                      customers with ≥4 locked weeks (the day-60 success-gate metric).
// Staff-or-admin gated, read-only.
import { ok } from '../../_lib/respond.js';
import { requireStaffOrAdmin } from '../../_lib/admin.js';
import { all } from '../../_lib/db.js';

export async function onRequestGet(context) {
  const denied = await requireStaffOrAdmin(context);
  if (denied) return denied;
  const db = context.env.DB;

  // Revenue per customer (succeeded payments only) — shared subquery for both source views.
  const REV = `(SELECT customer_id, SUM(amount_cents) AS rev, COUNT(*) AS payments
                FROM payments WHERE status = 'succeeded' AND amount_cents > 0 GROUP BY customer_id)`;

  const bySelf = await all(db,
    `SELECT COALESCE(a.self_reported, '(blank)') AS source, COUNT(*) AS signups,
            SUM(CASE WHEN p.rev > 0 THEN 1 ELSE 0 END) AS paying,
            COALESCE(SUM(p.rev), 0) AS revenue_cents
     FROM attribution a LEFT JOIN ${REV} p ON p.customer_id = a.customer_id
     GROUP BY 1 ORDER BY signups DESC`);

  const byUtm = await all(db,
    `SELECT COALESCE(a.utm_source,
              CASE WHEN a.gclid IS NOT NULL THEN 'google(click-id)'
                   WHEN a.fbclid IS NOT NULL THEN 'meta(click-id)'
                   ELSE '(organic/direct)' END) AS source,
            COALESCE(a.utm_campaign, '') AS campaign, COUNT(*) AS signups,
            SUM(CASE WHEN p.rev > 0 THEN 1 ELSE 0 END) AS paying,
            COALESCE(SUM(p.rev), 0) AS revenue_cents
     FROM attribution a LEFT JOIN ${REV} p ON p.customer_id = a.customer_id
     GROUP BY 1, 2 ORDER BY signups DESC`);

  const cohortByCoupon = await all(db,
    `SELECT COALESCE(s.coupon_code, '(none)') AS coupon,
            COUNT(*) AS customers,
            ROUND(AVG(COALESCE(o.weeks, 0)), 2) AS weeks_avg,
            SUM(CASE WHEN COALESCE(o.weeks, 0) >= 4 THEN 1 ELSE 0 END) AS retained_4wk,
            SUM(CASE WHEN s.status IN ('canceled') THEN 1 ELSE 0 END) AS canceled
     FROM subscriptions s
     LEFT JOIN (SELECT subscription_id, COUNT(*) AS weeks FROM orders
                WHERE status IN ('locked', 'prepped') GROUP BY subscription_id) o
       ON o.subscription_id = s.id
     GROUP BY 1 ORDER BY customers DESC`);

  return ok({ by_self_reported: bySelf, by_utm: byUtm, cohort_by_coupon: cohortByCoupon });
}
