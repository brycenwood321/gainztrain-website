// POST /api/admin/publish-menu — sync data/menus.json into the weekly_menus D1 table.
// LEGACY/MANUAL path (the Wed auto-publish cron was retired 2026-07-11): the prep dashboard's
// Finalize → Confirm & Go Live flow is how menus ship now. This endpoint still works for
// emergency/manual syncs, but NEW weeks land as status='staged' — an owner must still confirm
// them live (confirm-menu), so the file path can never bypass the go-live gate. Weeks that are
// already live stay live on re-sync (same rule as finalize-menu.js).
// Auth: X-Admin-Token = env.ADMIN_TOKEN.
import { ok, fail } from '../../_lib/respond.js';
import { requireAdmin } from '../../_lib/admin.js';
import { one, all, run, nowIso } from '../../_lib/db.js';
import { orderableWeek } from '../../_lib/menu.js';
import { notify } from '../../_lib/notify.js';

// Who gets the "new menu is live" blast: cooking-eligible subs with a real tier (paused excluded).
const ANNOUNCE_STATUSES = ['active', 'trialing', 'past_due'];

export async function onRequestPost(context) {
  const { request, env } = context;
  const denied = await requireAdmin(context);
  if (denied) return denied;

  let menus;
  try {
    const res = await fetch(new URL('/data/menus.json', request.url));
    if (!res.ok) return fail(502, 'menus_fetch_failed', `menus.json returned ${res.status}`);
    menus = (await res.json()).menus || [];
  } catch (e) {
    return fail(502, 'menus_fetch_failed', String(e).slice(0, 150));
  }

  // ?notify=1 → also email cooking-eligible subscribers "this week's menu is live" (for the orderable
  // week only, so publishing future weeks early doesn't blast anyone). Default is a silent data sync.
  const doNotify = new URL(request.url).searchParams.get('notify') === '1';

  const now = nowIso();
  let published = 0;
  const skipped = [];
  const publishedWeeks = [];
  for (const m of menus) {
    // Validate: week_of must be a YYYY-MM-DD that is a Sunday; meals must be a non-empty array.
    const okDate = typeof m.week_of === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m.week_of)
      && new Date(`${m.week_of}T12:00:00Z`).getUTCDay() === 0;
    if (!okDate) { skipped.push({ week_of: m.week_of ?? null, reason: 'week_of not a Sunday (YYYY-MM-DD)' }); continue; }
    if (!Array.isArray(m.meals) || m.meals.length === 0) { skipped.push({ week_of: m.week_of, reason: 'meals empty/missing' }); continue; }
    // Never overwrite a week the kitchen has already locked — that would retroactively change what
    // they're cooking. Republish only affects future/unlocked weeks.
    const locked = await one(env.DB, `SELECT 1 AS x FROM orders WHERE week_of = ? AND status = 'locked' LIMIT 1`, m.week_of);
    if (locked) { skipped.push({ week_of: m.week_of, reason: 'week already locked — menu frozen' }); continue; }
    // Don't clobber a week finalized from the prep dashboard (Marissa's Menu tab is the source of truth
    // for those weeks; this file-based sync must stay hands-off). See migration 0015 + finalize-menu.js.
    const owned = await one(env.DB, `SELECT source FROM weekly_menus WHERE week_of = ?`, m.week_of);
    if (owned && owned.source === 'dashboard') { skipped.push({ week_of: m.week_of, reason: 'finalized from prep dashboard — staff-owned' }); continue; }
    // New weeks are STAGED (owner-confirm gate applies); an existing week keeps its current status
    // (a live week stays live, a staged week stays staged) — this sync only refreshes the content.
    await run(env.DB,
      `INSERT INTO weekly_menus (week_of, label, meals_json, status, published_at, created_at, updated_at)
       VALUES (?, ?, ?, 'staged', ?, ?, ?)
       ON CONFLICT(week_of) DO UPDATE SET label=excluded.label, meals_json=excluded.meals_json,
         published_at=excluded.published_at, updated_at=excluded.updated_at`,
      m.week_of, m.label || null, JSON.stringify(m.meals), now, now, now);
    published++;
    publishedWeeks.push(m.week_of);
  }

  // Announce the orderable week's menu (deduped per customer+week, so re-running is safe).
  // Gate on the week being LIVE — a staged menu is invisible to customers, so announcing it would
  // point people at a menu they can't order from. confirm-menu owns the go-live blast now.
  const announceWeek = orderableWeek();
  let announced = 0;
  const liveRow = doNotify ? await one(env.DB, `SELECT 1 AS x FROM weekly_menus WHERE week_of = ? AND status = 'live'`, announceWeek) : null;
  if (doNotify && liveRow && publishedWeeks.includes(announceWeek)) {
    const subs = await all(env.DB,
      `SELECT c.id AS customer_id, c.email, c.first_name, c.ghl_contact_id
       FROM subscriptions s JOIN customers c ON c.id = s.customer_id
       WHERE s.status IN (${ANNOUNCE_STATUSES.map(() => '?').join(',')}) AND s.meals_per_week > 0 AND s.origin = 'app'`,
      ...ANNOUNCE_STATUSES);
    for (const sub of subs) {
      const cust = { id: sub.customer_id, email: sub.email, first_name: sub.first_name, ghl_contact_id: sub.ghl_contact_id };
      const r = await notify(env, cust, 'menu_posted', { weekOf: announceWeek }, { dedupKey: `menu_posted:${announceWeek}:${cust.id}` });
      if (r.ok && !r.deduped) announced++;
    }
  }
  return ok({ published, skipped, announced, announce_week: doNotify ? announceWeek : null });
}
