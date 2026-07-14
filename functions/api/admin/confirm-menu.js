// POST /api/admin/confirm-menu — the OWNER GO-LIVE gate. Flips a STAGED menu to LIVE so customers can
// order it. This is the deliberate weekly confirmation (nudged by the Sunday owner reminder). Staff-gated.
// The customer "new menu dropped" blast fires HERE (gated by MENU_BLAST_ENABLED), i.e. at go-live.
// BODY: { week_of: "YYYY-MM-DD" } — defaults to the orderable week.
import { ok, fail } from '../../_lib/respond.js';
import { requireOwner } from '../../_lib/admin.js';
import { one, all, run, nowIso } from '../../_lib/db.js';
import { orderableWeek } from '../../_lib/menu.js';
import { notify } from '../../_lib/notify.js';

const ANNOUNCE_STATUSES = ['active', 'trialing', 'past_due'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function onRequestPost(context) {
  const { request, env } = context;
  const denied = await requireOwner(context);
  if (denied) return denied;

  let body;
  try { body = await request.json(); } catch { body = {}; }
  const week = DATE_RE.test(body.week_of || '') ? body.week_of : orderableWeek();

  const row = await one(env.DB, `SELECT status FROM weekly_menus WHERE week_of = ?`, week);
  if (!row) return fail(404, 'no_menu', `No menu is staged for the week of ${week}. Build + finalize it first.`);
  if (row.status === 'live') return ok({ week_of: week, already_live: true, note: 'This menu is already live for customers.' });

  await run(env.DB, `UPDATE weekly_menus SET status='live', published_at=?, updated_at=? WHERE week_of = ?`,
    nowIso(), nowIso(), week);

  // Customer "new menu dropped" blast — GATED off until env.MENU_BLAST_ENABLED==='true'. Deduped per week.
  let announced = 0;
  const blastReady = String(env.MENU_BLAST_ENABLED) === 'true';
  if (blastReady && week === orderableWeek()) {
    const subs = await all(env.DB,
      `SELECT c.id AS customer_id, c.email, c.first_name, c.ghl_contact_id
       FROM subscriptions s JOIN customers c ON c.id = s.customer_id
       WHERE s.status IN (${ANNOUNCE_STATUSES.map(() => '?').join(',')}) AND s.meals_per_week > 0 AND s.origin = 'app'`,
      ...ANNOUNCE_STATUSES);
    for (const sub of subs) {
      const cust = { id: sub.customer_id, email: sub.email, first_name: sub.first_name, ghl_contact_id: sub.ghl_contact_id };
      const r = await notify(env, cust, 'menu_posted', { weekOf: week }, { dedupKey: `menu_posted:${week}:${cust.id}` });
      if (r.ok && !r.deduped) announced++;
    }
  }

  return ok({
    week_of: week,
    live: true,
    blast: blastReady ? `sent to ${announced} customer(s)` : 'held — customer blast off until MENU_BLAST_ENABLED is set',
  });
}
