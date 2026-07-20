// POST /api/t — first-party analytics beacon (public, anonymous: random visitor/session ids, no
// cookies, no IP stored). One endpoint, three message types from assets/js/attribution.js:
//   { t:'pageview',  ... }  → insert a page_views row + upsert the session (entry source stored once)
//   { t:'pv_update', ... }  → fill dwell_ms + max_scroll_pct on that pageview (keeps the max)
//   { t:'events', events:[] } → insert click/CTA/scroll/outbound/funnel rows + bump session counters
// Geo (country/region/city) + device come from the Cloudflare request + user-agent, server-side, so
// the client never has to send (or know) them. Rate-limited per IP; always answers 200.
import { ok } from '../_lib/respond.js';
import { run, one, nowIso } from '../_lib/db.js';
import { rateLimit, clientIp } from '../_lib/ratelimit.js';
import { randomToken } from '../_lib/crypto.js';

const clip = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
const int = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : null);
const okPath = (p) => typeof p === 'string' && p.startsWith('/') && !p.startsWith('/api');

// Tiny UA classifier — device + browser + os, no external dependency.
function ua(uaStr) {
  const s = uaStr || '';
  let device = 'desktop';
  if (/bot|crawl|spider|slurp|bingpreview|facebookexternalhit|headless/i.test(s)) device = 'bot';
  else if (/iPad|Tablet|PlayBook|Silk/i.test(s) || (/Android/i.test(s) && !/Mobile/i.test(s))) device = 'tablet';
  else if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(s)) device = 'mobile';
  let browser = 'other';
  if (/Edg\//i.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(s)) browser = 'Opera';
  else if (/Chrome\//i.test(s) && !/Chromium/i.test(s)) browser = 'Chrome';
  else if (/Firefox\//i.test(s)) browser = 'Firefox';
  else if (/Safari\//i.test(s) && /Version\//i.test(s)) browser = 'Safari';
  let os = 'other';
  if (/iPhone|iPad|iPod|iOS/i.test(s)) os = 'iOS';
  else if (/Android/i.test(s)) os = 'Android';
  else if (/Mac OS X|Macintosh/i.test(s)) os = 'macOS';
  else if (/Windows/i.test(s)) os = 'Windows';
  else if (/Linux/i.test(s)) os = 'Linux';
  return { device, browser, os };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  // Fire-and-forget: any limiter/parse/DB issue must never surface to the page → always 200.
  try {
    if (!(await rateLimit(env, `pv:ip:${clientIp(request)}`, 400, 600))) return ok({});
    const b = await request.json().catch(() => null);
    if (!b || typeof b !== 'object') return ok({});
    const type = b.t || 'pageview';
    const now = nowIso();
    const cf = request.cf || {};
    const geo = { country: clip(cf.country, 4), region: clip(cf.region, 60), city: clip(cf.city, 80) };

    if (type === 'pv_update') {
      // Keep the largest dwell/scroll seen for this pageview (multiple hidden/unload beacons can arrive).
      const pvId = clip(b.pv_id, 40);
      if (pvId) {
        await run(env.DB,
          `UPDATE page_views SET dwell_ms = MAX(COALESCE(dwell_ms,0), ?), max_scroll_pct = MAX(COALESCE(max_scroll_pct,0), ?)
           WHERE pv_id = ?`, int(b.dwell_ms) || 0, int(b.max_scroll_pct) || 0, pvId);
      }
      const sid = clip(b.session_id, 40);
      if (sid) await run(env.DB, `UPDATE sessions SET last_seen_at = ?, duration_ms = MAX(duration_ms, ?) WHERE id = ?`,
        now, int(b.dwell_ms) || 0, sid);
      return ok({});
    }

    if (type === 'events') {
      const sid = clip(b.session_id, 40), vid = clip(b.visitor_id, 40);
      const path = clip(b.path, 200);
      const evs = Array.isArray(b.events) ? b.events.slice(0, 30) : [];
      let n = 0;
      for (const e of evs) {
        if (!e || typeof e !== 'object') continue;
        await run(env.DB,
          `INSERT INTO analytics_events (id, session_id, visitor_id, type, path, label, href, value, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          randomToken(12), sid, vid, clip(e.type, 24) || 'custom', path,
          clip(e.label, 120), clip(e.href, 200), int(e.value), clip(e.at, 30) || now);
        n++;
      }
      if (sid && n) await run(env.DB, `UPDATE sessions SET event_count = event_count + ?, last_seen_at = ? WHERE id = ?`, n, now, sid);
      return ok({});
    }

    // type === 'pageview'
    const path = clip(b.path, 200);
    if (!okPath(path)) return ok({});
    const sid = clip(b.session_id, 40), vid = clip(b.visitor_id, 40);
    const d = ua(request.headers.get('user-agent'));
    const returning = b.returning ? 1 : 0;
    const utm = {
      source: clip(b.utm_source, 120), medium: clip(b.utm_medium, 120), campaign: clip(b.utm_campaign, 120),
      content: clip(b.utm_content, 120), term: clip(b.utm_term, 120),
      fbclid: clip(b.fbclid, 200), gclid: clip(b.gclid, 200),
    };

    // Session upsert: first pageview of a session writes the entry source ONCE; later pageviews only
    // touch last_seen + pageviews. INSERT OR IGNORE keeps the first-touch entry immutable.
    let isEntry = 0;
    if (sid) {
      const existing = await one(env.DB, `SELECT id FROM sessions WHERE id = ?`, sid);
      if (!existing) {
        isEntry = 1;
        await run(env.DB,
          `INSERT OR IGNORE INTO sessions (id, visitor_id, started_at, last_seen_at, entry_path, entry_referrer_host,
             utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, gclid,
             country, region, city, device, browser, os, is_returning, pageviews)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          sid, vid, now, now, path, clip(b.referrer_host, 120),
          utm.source, utm.medium, utm.campaign, utm.content, utm.term, utm.fbclid, utm.gclid,
          geo.country, geo.region, geo.city, d.device, d.browser, d.os, returning);
      } else {
        await run(env.DB, `UPDATE sessions SET last_seen_at = ?, pageviews = pageviews + 1 WHERE id = ?`, now, sid);
      }
    }

    await run(env.DB,
      `INSERT INTO page_views (day, path, title, pv_id, session_id, visitor_id, utm_source, utm_medium, utm_campaign,
         utm_content, referrer_host, is_returning, is_entry, device, country, region, city, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      now.slice(0, 10), path, clip(b.title, 160), clip(b.pv_id, 40), sid, vid,
      utm.source, utm.medium, utm.campaign, utm.content, clip(b.referrer_host, 120),
      returning, isEntry, d.device, geo.country, geo.region, geo.city, now);
  } catch { /* never fail a beacon */ }
  return ok({});
}
