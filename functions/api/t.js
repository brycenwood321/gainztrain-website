// POST /api/t — first-party page-view beacon (public, PII-free: no cookies, no IP, no user id).
// Sent once per page land by assets/js/attribution.js on the public marketing pages. Rows aggregate
// into the ops Marketing funnel (views per source) so ad-click volume is measurable in OUR database
// from the first ad, independent of Meta/GA4 dashboards. Rate-limited per IP; inserts only.
import { ok } from '../_lib/respond.js';
import { run, nowIso } from '../_lib/db.js';
import { rateLimit, clientIp } from '../_lib/ratelimit.js';

const clip = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);

export async function onRequestPost(context) {
  const { request, env } = context;
  // Beacons are fire-and-forget: always answer 200 so a limiter/parse issue never surfaces client-side.
  try {
    if (!(await rateLimit(env, `pv:ip:${clientIp(request)}`, 60, 600))) return ok({});
    const b = await request.json().catch(() => null);
    if (!b || typeof b !== 'object') return ok({});
    const path = clip(b.path, 200);
    if (!path || !path.startsWith('/') || path.startsWith('/app') || path.startsWith('/api')) return ok({});
    const now = nowIso();
    await run(env.DB,
      `INSERT INTO page_views (day, path, utm_source, utm_medium, utm_campaign, utm_content, referrer_host, is_returning, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      now.slice(0, 10), path,
      clip(b.utm_source, 120), clip(b.utm_medium, 120), clip(b.utm_campaign, 120), clip(b.utm_content, 120),
      clip(b.referrer_host, 120), b.returning ? 1 : 0, now);
  } catch { /* never fail a beacon */ }
  return ok({});
}
