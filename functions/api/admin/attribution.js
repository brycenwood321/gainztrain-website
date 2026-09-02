// GET /api/admin/attribution — the Phase 1 marketing "money query" (GT_MARKETING_PLAN_2026-07-08 §6):
// source → signups → paying customers → revenue, from three angles:
//   by_self_reported : the required "how did you hear about us?" answer (catches dark social)
//   by_utm           : first-touch UTM source, falling back to ad click-ids (gclid/fbclid)
//   cohort_by_coupon : retention per offer code — the Bernstein/HelloFresh lesson made queryable.
//                      weeks_avg = avg locked/prepped weekly orders per customer; retained_4wk counts
//                      customers with ≥4 locked weeks (the day-60 success-gate metric).
// Staff-or-admin gated, read-only.
import { ok } from '../../_lib/respond.js';
import { requireOwner } from '../../_lib/admin.js';
import { all } from '../../_lib/db.js';

export async function onRequestGet(context) {
  const denied = await requireOwner(context);
  if (denied) return denied;
  const db = context.env.DB;

  // Revenue per customer (succeeded payments only) — shared subquery for both source views.
  const REV = `(SELECT customer_id, SUM(amount_cents) AS rev, COUNT(*) AS payments
                FROM payments WHERE status = 'succeeded' AND amount_cents > 0 GROUP BY customer_id)`;

  const bySelfRaw = await all(db,
    `SELECT COALESCE(a.self_reported, '(blank)') AS source, COUNT(*) AS signups,
            SUM(CASE WHEN p.rev > 0 THEN 1 ELSE 0 END) AS paying,
            COALESCE(SUM(p.rev), 0) AS revenue_cents
     FROM attribution a LEFT JOIN ${REV} p ON p.customer_id = a.customer_id
     GROUP BY 1 ORDER BY signups DESC`);
  // The free text behind "other", "friend" and "gym" (what people actually typed), newest first, so
  // "other" is never a mystery bucket. Legacy 'facebook' rows predate the ad/Marketplace/organic split.
  const detailRows = await all(db,
    `SELECT self_reported AS source, self_reported_detail AS detail FROM attribution
      WHERE self_reported_detail IS NOT NULL AND TRIM(self_reported_detail) != ''
      ORDER BY created_at DESC LIMIT 200`);
  const detailsBy = {};
  for (const r of detailRows) {
    const k = r.source || '(blank)';
    (detailsBy[k] = detailsBy[k] || []);
    if (detailsBy[k].length < 20) detailsBy[k].push(String(r.detail).slice(0, 120));
  }
  const bySelf = bySelfRaw.map((r) => ({
    ...r,
    label: r.source === 'facebook' ? 'facebook (before split)' : r.source,
    details: detailsBy[r.source] || [],
  }));

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

  // ── Full funnel: views (first-party beacon) + spend (manual log) merged with signups/revenue ──
  // Sources normalize to channels so a facebook/instagram utm, a fbclid, and a "meta" spend row all
  // land on one row: channel → views → signups → paying → revenue → spend → CPL → CAC.
  const views = await all(db,
    `SELECT COALESCE(utm_source, CASE WHEN referrer_host LIKE '%google%' THEN 'google-organic'
                                      WHEN referrer_host LIKE '%facebook%' OR referrer_host LIKE '%instagram%' THEN 'meta-organic'
                                      WHEN referrer_host IS NOT NULL THEN referrer_host
                                      ELSE '(direct)' END) AS source,
            COUNT(*) AS views,
            SUM(CASE WHEN day >= date('now', '-30 day') THEN 1 ELSE 0 END) AS views_30d
     FROM page_views GROUP BY 1`);
  const spend = await all(db,
    `SELECT channel, SUM(spend_cents) AS spend_cents FROM marketing_spend GROUP BY channel`);

  const toChannel = (s) => {
    const v = String(s || '').toLowerCase();
    if (/facebook|instagram|^fb$|^ig$|meta/.test(v)) return 'meta';
    if (/google|gbp|youtube/.test(v)) return 'google';
    if (/tiktok/.test(v)) return 'tiktok';
    if (/marketplace/.test(v)) return 'marketplace';
    if (!v || v === '(direct)' || v === '(organic/direct)' || v === '(blank)') return 'organic/direct';
    return v;
  };
  const funnel = {};
  const row = (ch) => (funnel[ch] = funnel[ch] || { channel: ch, views: 0, views_30d: 0, signups: 0, paying: 0, revenue_cents: 0, spend_cents: 0 });
  for (const v of views) { const r = row(toChannel(v.source)); r.views += v.views; r.views_30d += v.views_30d; }
  for (const u of byUtm) { const r = row(toChannel(u.source)); r.signups += u.signups; r.paying += u.paying || 0; r.revenue_cents += u.revenue_cents || 0; }
  for (const s of spend) { row(toChannel(s.channel)).spend_cents += s.spend_cents || 0; }
  const funnelRows = Object.values(funnel).map((r) => ({
    ...r,
    cpl_cents: r.signups > 0 && r.spend_cents > 0 ? Math.round(r.spend_cents / r.signups) : null,
    cac_cents: r.paying > 0 && r.spend_cents > 0 ? Math.round(r.spend_cents / r.paying) : null,
  })).sort((a, b) => b.views - a.views);

  return ok({ funnel: funnelRows, by_self_reported: bySelf, by_utm: byUtm, cohort_by_coupon: cohortByCoupon });
}
