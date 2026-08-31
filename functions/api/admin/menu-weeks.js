// GET /api/admin/menu-weeks — staff-gated. Powers the prep dashboard's "schedule menus in advance" week
// picker: the next 8 orderable Sundays with, for each, whether a menu is already published, how many meals
// it has, where it came from (dashboard vs menus.json cron), and whether the kitchen has locked it (frozen).
// The dashboard uses this to let Marissa build/publish a menu for any upcoming week, not just this one.
import { ok } from '../../_lib/respond.js';
import { requireOwner } from '../../_lib/admin.js';
import { all } from '../../_lib/db.js';
import { orderableWeek } from '../../_lib/menu.js';

const HORIZON = 8; // future weeks shown in the picker
// Past weeks kept in the picker for reference, READ-ONLY. Before this, the list started at the next
// orderable week, so every Monday the week the kitchen had just cooked and delivered vanished from
// both the picker and the Ingredients view with no way to look it back up. Marissa, 2026-08-31.
const PAST = 2;

function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const addWeeks = (iso, n) => addDays(iso, n * 7);
// week_of is the SUNDAY the food is delivered, but the team names a week by the Monday it goes live,
// which is 6 days earlier: week_of 2026-09-06 is "the week of Aug 31". Storage keeps the Sunday;
// this is the label the dashboard shows so the picker matches how they actually talk about weeks.
const mondayLabel = (iso) => addDays(iso, -6);

export async function onRequestGet(context) {
  const denied = await requireOwner(context);
  if (denied) return denied;
  const { env } = context;

  const orderable = orderableWeek();
  const start = addWeeks(orderable, -PAST);
  const weeks = [];
  for (let i = 0; i < HORIZON + PAST; i++) weeks.push(addWeeks(start, i));
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
    // A week older than the orderable one has already been ordered, cooked and delivered. It stays
    // visible so the kitchen can refer back, but nothing about it may be edited or re-finalized.
    const past = w < orderable;
    return { week_of: w, label_week_of: mondayLabel(w), index: i, published: !!m, status,
             live: status === 'live', source: m ? m.source : null, meal_count,
             locked: lSet.has(w), past, editable: !past };
  });

  return ok({ orderable_week: orderable, weeks: out });
}
