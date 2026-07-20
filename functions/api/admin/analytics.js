// GET /api/admin/analytics — first-party web-analytics rollups for the ops Analytics tab (owner-only).
// Reads analytics_sessions + page_views + analytics_events (all populated by the /api/t beacon).
// ?days=N windows everything (default 30). Everything is anonymous + aggregate.
import { ok } from '../../_lib/respond.js';
import { requireOwner } from '../../_lib/admin.js';
import { all, one } from '../../_lib/db.js';

export async function onRequestGet(context) {
  const denied = await requireOwner(context);
  if (denied) return denied;
  const db = context.env.DB;

  const days = Math.min(365, Math.max(1, parseInt(new URL(context.request.url).searchParams.get('days') || '30', 10) || 30));
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const since1 = new Date(Date.now() - 86400000).toISOString();

  // Overview — sessions/visitors/pageviews + engagement, for the window and for the last 24h.
  const ov = await one(db,
    `SELECT COUNT(*) AS sessions, COUNT(DISTINCT visitor_id) AS visitors,
            COALESCE(SUM(pageviews), 0) AS pageviews,
            SUM(CASE WHEN pageviews <= 1 THEN 1 ELSE 0 END) AS bounces,
            SUM(CASE WHEN is_returning = 1 THEN 1 ELSE 0 END) AS returning,
            AVG(CASE WHEN duration_ms > 0 THEN duration_ms END) AS avg_dur_ms
     FROM analytics_sessions WHERE started_at >= ?`, since);
  const ov24 = await one(db,
    `SELECT COUNT(*) AS sessions, COALESCE(SUM(pageviews),0) AS pageviews FROM analytics_sessions WHERE started_at >= ?`, since1);

  // Where they come from — utm_source, else referrer host, else (direct).
  const sources = await all(db,
    `SELECT COALESCE(NULLIF(utm_source,''), NULLIF(entry_referrer_host,''), '(direct)') AS source,
            COALESCE(utm_medium,'') AS medium,
            COUNT(*) AS sessions,
            SUM(CASE WHEN pageviews <= 1 THEN 1 ELSE 0 END) AS bounces,
            SUM(converted) AS conversions,
            AVG(CASE WHEN duration_ms > 0 THEN duration_ms END) AS avg_dur_ms
     FROM analytics_sessions WHERE started_at >= ? GROUP BY source, medium ORDER BY sessions DESC LIMIT 25`, since);

  // Top pages — views, avg dwell, avg scroll depth, entries.
  const pages = await all(db,
    `SELECT path, COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors,
            AVG(CASE WHEN dwell_ms > 0 THEN dwell_ms END) AS avg_dwell_ms,
            AVG(max_scroll_pct) AS avg_scroll,
            SUM(is_entry) AS entries
     FROM page_views WHERE created_at >= ? AND session_id IS NOT NULL GROUP BY path ORDER BY views DESC LIMIT 25`, since);

  // Device + geo mix.
  const devices = await all(db,
    `SELECT COALESCE(device,'unknown') AS device, COUNT(*) AS sessions FROM analytics_sessions WHERE started_at >= ? GROUP BY device ORDER BY sessions DESC`, since);
  const geo = await all(db,
    `SELECT COALESCE(NULLIF(region,''),'(unknown)') AS region, COALESCE(NULLIF(city,''),'') AS city, COUNT(*) AS sessions
     FROM analytics_sessions WHERE started_at >= ? GROUP BY region, city ORDER BY sessions DESC LIMIT 20`, since);

  // Funnel — distinct visitors who reached each key step (path-based), plus actual signups in-window.
  const step = async (like) => (await one(db,
    `SELECT COUNT(DISTINCT visitor_id) AS v FROM page_views WHERE created_at >= ? AND path LIKE ?`, since, like))?.v || 0;
  const funnel = {
    fuel: await step('/fuel%'),
    menu: await step('/menu%'),
    start: await step('/start%'),
    signups: (await one(db, `SELECT COUNT(*) AS n FROM attribution WHERE created_at >= ?`, since))?.n || 0,
  };

  // Most-clicked CTAs / links / outbound.
  const ctas = await all(db,
    `SELECT type, COALESCE(NULLIF(label,''),'(unlabeled)') AS label, COALESCE(href,'') AS href, COUNT(*) AS clicks
     FROM analytics_events WHERE created_at >= ? AND type IN ('cta','click','outbound')
     GROUP BY type, label, href ORDER BY clicks DESC LIMIT 20`, since);

  // Sessions + pageviews per day (trend, most recent last).
  const byDay = await all(db,
    `SELECT substr(started_at,1,10) AS day, COUNT(*) AS sessions, COALESCE(SUM(pageviews),0) AS pageviews,
            COUNT(DISTINCT visitor_id) AS visitors
     FROM analytics_sessions WHERE started_at >= ? GROUP BY day ORDER BY day`, since);

  // Recent visitor journeys — last 12 sessions with their ordered page path.
  const recentSessions = await all(db,
    `SELECT id, started_at, COALESCE(NULLIF(utm_source,''), NULLIF(entry_referrer_host,''), '(direct)') AS source,
            device, COALESCE(NULLIF(region,''),'') AS region, COALESCE(NULLIF(city,''),'') AS city,
            pageviews, duration_ms, converted
     FROM analytics_sessions WHERE started_at >= ? ORDER BY started_at DESC LIMIT 12`, since);
  const ids = recentSessions.map((s) => s.id);
  let journeys = [];
  if (ids.length) {
    const rows = await all(db,
      `SELECT session_id, path, dwell_ms, created_at FROM page_views
       WHERE session_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at`, ...ids);
    const bySession = {};
    for (const r of rows) (bySession[r.session_id] = bySession[r.session_id] || []).push({ path: r.path, dwell_ms: r.dwell_ms });
    journeys = recentSessions.map((s) => ({ ...s, steps: bySession[s.id] || [] }));
  }

  return ok({
    window_days: days,
    overview: {
      sessions: ov?.sessions || 0, visitors: ov?.visitors || 0, pageviews: ov?.pageviews || 0,
      bounces: ov?.bounces || 0, returning: ov?.returning || 0, avg_dur_ms: Math.round(ov?.avg_dur_ms || 0),
      sessions_24h: ov24?.sessions || 0, pageviews_24h: ov24?.pageviews || 0,
    },
    sources, pages, devices, geo, funnel, ctas, by_day: byDay, journeys,
  });
}
