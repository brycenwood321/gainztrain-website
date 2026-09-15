// /api/admin/marketing-time — minutes spent on marketing, by hand (owner). Plan rev 4, 09-28 build.
// GET: last 100 rows + per-person totals for the last 7 and 30 days.
// POST { day: 'YYYY-MM-DD', who: brycen|jayson|other, minutes: 1..600, what? }
// The Monday email (marketing-weekly.js) sums this per person for the window.
import { ok, fail, readJson } from '../../_lib/respond.js';
import { requireOwner } from '../../_lib/admin.js';
import { all, run, nowIso } from '../../_lib/db.js';

const WHO = new Set(['brycen', 'jayson', 'other']);

export async function minutesByPerson(db, startDay, endDayExcl) {
  return all(db,
    `SELECT who, SUM(minutes) AS minutes, COUNT(*) AS sittings FROM marketing_time
      WHERE day >= ? AND day < ? GROUP BY who ORDER BY minutes DESC`, startDay, endDayExcl);
}

export async function onRequestGet(context) {
  const denied = await requireOwner(context);
  if (denied) return denied;
  const db = context.env.DB;
  const entries = await all(db, `SELECT id, day, who, minutes, what FROM marketing_time ORDER BY day DESC, id DESC LIMIT 100`);
  const totals = await all(db,
    `SELECT who,
            SUM(CASE WHEN day >= date('now', '-7 day') THEN minutes ELSE 0 END) AS last7,
            SUM(CASE WHEN day >= date('now', '-30 day') THEN minutes ELSE 0 END) AS last30
       FROM marketing_time GROUP BY who ORDER BY last30 DESC`);
  return ok({ entries, totals });
}

export async function onRequestPost(context) {
  const denied = await requireOwner(context);
  if (denied) return denied;
  const b = await readJson(context.request);
  const day = String(b.day || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return fail(400, 'bad_day', 'day must be YYYY-MM-DD');
  const who = String(b.who || '').toLowerCase().trim();
  if (!WHO.has(who)) return fail(400, 'bad_who', `who must be one of: ${[...WHO].join(', ')}`);
  const minutes = Math.round(Number(b.minutes));
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 600) return fail(400, 'bad_minutes', 'minutes must be 1 to 600');
  await run(context.env.DB,
    `INSERT INTO marketing_time (day, who, minutes, what, created_at) VALUES (?, ?, ?, ?, ?)`,
    day, who, minutes, String(b.what || '').slice(0, 160) || null, nowIso());
  return ok({ logged: { day, who, minutes } });
}
