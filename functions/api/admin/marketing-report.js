// GET /api/admin/marketing-report — the funnel, sliceable by any marketing dimension (owner-only).
//
// Answers the question the ad account cannot: which OFFER / HOOK / AUDIENCE / PLACEMENT actually
// produces customers. Spend comes from Meta (marketing_spend, keyed per ad_id by
// gainz-train/scripts/meta_spend_sync.py); everything downstream is first-party.
//
//   ?by=offer|placement|hook|audience|creative_type|campaign|ad   (default: offer)
//   ?days=N            window, default 30, max 365
//
// TWO GUARDS THAT KEEP THIS HONEST — do not remove them to make a number look better:
//
//  1. CRAWLER / MISDELIVERY FILTER. Paid sessions from outside the ad's target_region are excluded
//     from every rate. Publishing an ad edit on 2026-08-05 produced 6 "sessions" in 34 seconds from
//     Prineville OR, Boardman OR, Forest City NC, Gallatin TN and Fort Worth TX — all Meta data
//     centers, all reporting a placement the campaign explicitly excludes. That is Meta's review
//     crawler. Counted as traffic it silently inflates every denominator. They are returned
//     separately as `excluded_out_of_region` so the volume stays visible.
//
//  2. SAMPLE-SIZE FLAGS. At ~1 purchase per 130 clicks, comparing offers on PURCHASE rate needs
//     years of data. Each row reports `readable`, and the default verdict metric is the mid-funnel
//     reached-checkout rate, which fires ~90x more often. Purchases are shown, never auto-judged.
import { ok, fail } from '../../_lib/respond.js';
import { requireOwner } from '../../_lib/admin.js';
import { all } from '../../_lib/db.js';

// Where the dimension lives. Session-level = what the visitor actually saw. Registry-level = what
// the ad was configured to be. `offer` deliberately prefers the session: the truth is what rendered.
const DIMENSIONS = {
  offer:         { expr: "COALESCE(s.offer, v.offer)", spend: 'v.offer',        spendable: true },
  placement:     { expr: 's.utm_term',                 spend: null,             spendable: false },
  hook:          { expr: 'v.hook',                     spend: 'v.hook',         spendable: true },
  audience:      { expr: 'v.audience',                 spend: 'v.audience',     spendable: true },
  creative_type: { expr: 'v.creative_type',            spend: 'v.creative_type', spendable: true },
  campaign:      { expr: 'COALESCE(v.campaign, s.utm_campaign)', spend: 'v.campaign', spendable: true },
  ad:            { expr: 'COALESCE(v.ad_name, s.ad_id)', spend: 'v.ad_name',    spendable: true },
};

// Engagement = got far enough to have actually read something. 25% scroll OR 15s of active dwell.
const ENGAGED = '(pv.max_scroll_pct >= 25 OR pv.dwell_ms >= 15000)';
// Comparing two rates wants ~30 events in the numerator before the difference means anything.
const MIN_READABLE = 30;
const MIN_READABLE_PURCHASE = 25;

export async function onRequestGet(context) {
  const denied = await requireOwner(context);
  if (denied) return denied;
  const db = context.env.DB;
  const url = new URL(context.request.url);

  const by = (url.searchParams.get('by') || 'offer').toLowerCase();
  const dim = DIMENSIONS[by];
  if (!dim) return fail(400, 'bad_dimension', `by must be one of: ${Object.keys(DIMENSIONS).join(', ')}`);

  const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days') || '30', 10) || 30));
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const sinceDay = since.slice(0, 10);

  // A paid session counts only if it landed inside the geo the ad targets. target_region NULL means
  // the ad predates the column, so we do not silently drop its traffic.
  const IN_REGION = "(v.target_region IS NULL OR s.region = v.target_region)";

  // ── Funnel from first-party data ──────────────────────────────────────────────────────────────
  // Every step is counted in SESSIONS, not pageviews — a visitor who loads three pages is one
  // person, and mixing the two makes the denominators incoherent. The click -> session gap is the
  // pre-load bounce (32% on the founders ad); Meta's link_clicks is the step above sessions.
  const funnel = await all(db,
    `SELECT ${dim.expr} AS dim,
            COUNT(DISTINCT s.id)                                            AS sessions,
            COUNT(DISTINCT CASE WHEN pv.is_entry = 1 THEN pv.id END)        AS landing_views,
            COUNT(DISTINCT CASE WHEN ${ENGAGED} THEN s.id END)              AS engaged,
            COUNT(DISTINCT CASE WHEN pv.path LIKE '/start%' OR pv.path LIKE '/menu%' THEN s.id END)
                                                                            AS reached_checkout
       FROM analytics_sessions s
       LEFT JOIN marketing_variants v ON v.key = s.ad_id
       LEFT JOIN page_views pv        ON pv.session_id = s.id
      WHERE s.started_at >= ?
        AND ${IN_REGION}
        AND ${dim.expr} IS NOT NULL
      GROUP BY 1`, since);

  // Signups + paying + revenue, attributed by the customer's first touch.
  const money = await all(db,
    `SELECT ${dim.expr.replace(/\bs\./g, 'a.')} AS dim,
            COUNT(DISTINCT a.customer_id) AS signups,
            COUNT(DISTINCT p.customer_id) AS paying,
            COALESCE(SUM(p.rev), 0) / 100.0 AS revenue_usd
       FROM attribution a
       LEFT JOIN marketing_variants v ON v.key = a.ad_id
       LEFT JOIN (SELECT customer_id, SUM(amount_cents) AS rev FROM payments
                   WHERE status = 'succeeded' AND amount_cents > 0 GROUP BY customer_id) p
              ON p.customer_id = a.customer_id
      WHERE a.created_at >= ?
        AND ${dim.expr.replace(/\bs\./g, 'a.')} IS NOT NULL
      GROUP BY 1`, since);

  // Spend, only for dimensions that a spend row can actually be resolved to. marketing_spend is
  // per ad per day, so placement-level spend is NOT derivable and is reported as null rather than
  // guessed at.
  const spend = dim.spendable ? await all(db,
    `SELECT ${dim.spend} AS dim,
            SUM(ms.spend_cents) / 100.0 AS spend_usd,
            SUM(ms.impressions)         AS impressions,
            SUM(ms.link_clicks)         AS link_clicks
       FROM marketing_spend ms
       JOIN marketing_variants v ON v.key = ms.ad_id
      WHERE ms.day >= ? AND ${dim.spend} IS NOT NULL
      GROUP BY 1`, sinceDay) : [];

  // What the crawler filter removed, kept visible on purpose.
  const excluded = await all(db,
    `SELECT COUNT(*) AS sessions, COUNT(DISTINCT s.region) AS regions
       FROM analytics_sessions s JOIN marketing_variants v ON v.key = s.ad_id
      WHERE s.started_at >= ? AND v.target_region IS NOT NULL AND s.region <> v.target_region`, since);

  // Change markers so any before/after read is anchored to an exact cut.
  const changes = await all(db,
    `SELECT id, cut_at, surface, summary FROM marketing_changes WHERE cut_at >= ? ORDER BY cut_at`, since);

  // ── Merge ─────────────────────────────────────────────────────────────────────────────────────
  const rows = new Map();
  const touch = (k) => {
    if (!rows.has(k)) {
      rows.set(k, {
        dim: k, spend_usd: null, impressions: null, link_clicks: null,
        sessions: 0, landing_views: 0, engaged: 0, reached_checkout: 0,
        signups: 0, paying: 0, revenue_usd: 0,
      });
    }
    return rows.get(k);
  };
  for (const f of funnel) Object.assign(touch(f.dim), {
    sessions: f.sessions, landing_views: f.landing_views, engaged: f.engaged,
    reached_checkout: f.reached_checkout,
  });
  for (const m of money) Object.assign(touch(m.dim), {
    signups: m.signups, paying: m.paying, revenue_usd: m.revenue_usd,
  });
  for (const s of spend) Object.assign(touch(s.dim), {
    spend_usd: s.spend_usd, impressions: s.impressions, link_clicks: s.link_clicks,
  });

  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
  const out = [...rows.values()].map((r) => ({
    ...r,
    // Rates are per SESSION. engaged_rate and checkout_rate are the ones worth comparing at low
    // volume; both fire far more often than a purchase.
    engaged_rate_pct: pct(r.engaged, r.sessions),
    checkout_rate_pct: pct(r.reached_checkout, r.sessions),
    signup_rate_pct: pct(r.signups, r.sessions),
    // Meta counted the click; our beacon counted the session. The gap is the pre-load bounce.
    preload_bounce_pct: r.link_clicks > 0 && r.sessions <= r.link_clicks
      ? Math.round(((r.link_clicks - r.sessions) / r.link_clicks) * 1000) / 10 : null,
    cac_usd: r.paying > 0 && r.spend_usd != null ? Math.round((r.spend_usd / r.paying) * 100) / 100 : null,
    revenue_per_click: r.link_clicks > 0 && r.link_clicks != null
      ? Math.round((r.revenue_usd / r.link_clicks) * 100) / 100 : null,
    roas: r.spend_usd > 0 ? Math.round((r.revenue_usd / r.spend_usd) * 100) / 100 : null,
    readable: {
      // Is there enough here to compare this row against another one?
      primary: r.reached_checkout >= MIN_READABLE,
      purchases: r.paying >= MIN_READABLE_PURCHASE,
      note: r.reached_checkout >= MIN_READABLE
        ? null
        : `not enough data to compare — ${r.reached_checkout}/${MIN_READABLE} checkout events`,
    },
  })).sort((a, b) => (b.landing_views - a.landing_views) || (b.sessions - a.sessions));

  return ok({
    by,
    days,
    since,
    primary_metric: 'checkout_rate_pct',
    primary_metric_note:
      'Compare offers on checkout_rate_pct, not on purchases. At ~1 purchase per 130 clicks a '
      + 'purchase-rate comparison needs years of data; this mid-funnel step fires ~90x more often.',
    spend_available: dim.spendable,
    spend_note: dim.spendable ? null
      : 'marketing_spend is stored per ad per day, so spend cannot be split by this dimension.',
    excluded_out_of_region: excluded[0] || { sessions: 0, regions: 0 },
    excluded_note:
      'Paid sessions outside the ad target_region are excluded from all rates. These are usually '
      + "Meta's ad-review crawler (data-center cities, excluded placements), not prospects.",
    changes,
    rows: out,
  });
}
