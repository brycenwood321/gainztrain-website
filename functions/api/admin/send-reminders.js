// POST /api/admin/send-reminders — email active subscribers who haven't picked their meals for the
// orderable week yet (a few days before the Friday cutoff). In-app reminder already exists (/app/menu
// shows "no meals picked"); this is the email nudge. SMS reminder is added once A2P clears.
// Admin-gated. ?dry=1 to preview who would be reminded without sending.
import { ok, fail } from '../../_lib/respond.js';
import { requireAdmin } from '../../_lib/admin.js';
import { one, all } from '../../_lib/db.js';
import { orderableWeek, isLocked, cutoffForWeek } from '../../_lib/menu.js';
import { notify } from '../../_lib/notify.js';

const ACTIVE = ['active', 'trialing', 'past_due']; // paused customers don't order, don't nag them

export async function onRequestPost(context) {
  const { request, env } = context;
  const denied = await requireAdmin(context);
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const dry = params.get('dry') === '1';
  const final = params.get('final') === '1'; // Friday last-call tone vs the Wednesday nudge
  const week = orderableWeek();
  if (isLocked(week)) return ok({ skipped: 'week_already_locked', week_of: week });

  const cutoff = cutoffForWeek(week).toISOString().slice(0, 10);
  const subs = await all(env.DB,
    `SELECT s.id, s.meals_per_week, c.id AS customer_id, c.email, c.first_name, c.ghl_contact_id
     FROM subscriptions s JOIN customers c ON c.id = s.customer_id
     WHERE s.status IN (${ACTIVE.map(() => '?').join(',')})`, ...ACTIVE);

  const tpl = final ? 'meal_reminder_final' : 'meal_reminder';
  const summary = { week_of: week, candidates: 0, reminded: 0, already_picked: 0, no_contact: 0, deduped: 0, dry, final };
  for (const sub of subs) {
    if (!(sub.meals_per_week > 0)) continue; // legacy 0-meal subs: not orderable yet, skip
    const picked = await one(env.DB,
      `SELECT COALESCE(SUM(qty),0) AS n FROM meal_selections WHERE subscription_id = ? AND week_of = ?`, sub.id, week);
    if ((picked?.n || 0) === sub.meals_per_week) { summary.already_picked++; continue; }
    summary.candidates++;
    if (dry) continue;
    // Through notify() so it's deduped (a re-delivered cron / manual re-run can't re-blast everyone) and
    // gets the SMS leg + comms_log logging for free. One nudge + one final per sub per week.
    const cust = { id: sub.customer_id, email: sub.email, first_name: sub.first_name, ghl_contact_id: sub.ghl_contact_id };
    const r = await notify(env, cust, tpl,
      { weekOf: week, mealsPerWeek: sub.meals_per_week, cutoff },
      { dedupKey: `reminder:${final ? 'final' : 'nudge'}:${sub.id}:${week}` });
    if (r.deduped) summary.deduped++;
    else if (r.ok) summary.reminded++;
    else summary.no_contact++;
  }
  return ok({ summary });
}
