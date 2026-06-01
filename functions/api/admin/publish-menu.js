// POST /api/admin/publish-menu — sync data/menus.json into the weekly_menus D1 table
// (D1 = source of truth for the app + ops scheduler). Idempotent upsert by week_of.
// Auth: X-Admin-Token = env.ADMIN_TOKEN. Run after editing menus.json each week.
import { ok, fail } from '../../_lib/respond.js';
import { run, nowIso } from '../../_lib/db.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const token = request.headers.get('x-admin-token') || '';
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return fail(401, 'unauthorized', 'Bad admin token.');

  let menus;
  try {
    const res = await fetch(new URL('/data/menus.json', request.url));
    if (!res.ok) return fail(502, 'menus_fetch_failed', `menus.json returned ${res.status}`);
    menus = (await res.json()).menus || [];
  } catch (e) {
    return fail(502, 'menus_fetch_failed', String(e).slice(0, 150));
  }

  const now = nowIso();
  let published = 0;
  for (const m of menus) {
    if (!m.week_of || !Array.isArray(m.meals)) continue;
    await run(env.DB,
      `INSERT INTO weekly_menus (week_of, label, meals_json, published_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(week_of) DO UPDATE SET label=excluded.label, meals_json=excluded.meals_json,
         published_at=excluded.published_at, updated_at=excluded.updated_at`,
      m.week_of, m.label || null, JSON.stringify(m.meals), now, now, now);
    published++;
  }
  return ok({ published });
}
