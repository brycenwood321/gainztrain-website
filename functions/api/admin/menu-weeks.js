// GET /api/admin/menu-weeks — staff-gated. Powers the prep dashboard's "schedule menus in advance" week
// picker: the next 8 orderable Sundays with, for each, whether a menu is already published, how many meals
// it has, where it came from (dashboard vs menus.json cron), and whether the kitchen has locked it (frozen).
// The dashboard uses this to let Marissa build/publish a menu for any upcoming week, not just this one.
import { ok } from '../../_lib/respond.js';
import { requireStaffOrAdmin } from '../../_lib/admin.js';
import { all } from '../../_lib/db.js';
import { orderableWeek } from '../../_lib/menu.js';

const HORIZON = 8; // weeks shown in the picker

function addWeeks(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n * 7);
  return d.toISOString().slice(0, 10);
}

export async function onRequestGet(context) {
  const denied = await requireStaffOrAdmin(context);
  if (denied) return denied;
  const { env } = context;

  const start = orderableWeek();
  const weeks = [];
  for (let i = 0; i < HORIZON; i++) weeks.push(addWeeks(start, i));
  const ph = weeks.map(() => '?').join(',');

  const menus = await all(env.DB, `SELECT week_of, source, status, meals_json FROM weekly_menus WHERE week_of IN (${ph})`, ...weeks);
  const locks = await all(env.DB, `SELECT DISTINCT week_of FROM orders WHERE status = 'locked' AND week_of IN (${ph})`, ...weeks);
  const mMap = new Map(menus.map((m) => [m.week_of, m]));
  const lSet = new Set(locks.map((l) => l.week_of));

  const out = weeks.map((w, i) => {
    const m = mMap.get(w);
    let meal_count = 0;
    if (m) { try { meal_count = JSON.parse(m.meals_json).length; } catch { meal_count = 0; } }
    // status: 'live' (owner-confirmed, customers see it) | 'staged' (finalized, awaiting confirm) | null (no menu)
    const status = m ? (m.status || 'live') : null;
    return { week_of: w, index: i, published: !!m, status, live: status === 'live', source: m ? m.source : null, meal_count, locked: lSet.has(w) };
  });

  return ok({ orderable_week: start, weeks: out });
}
