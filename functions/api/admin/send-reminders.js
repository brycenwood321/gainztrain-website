// POST /api/admin/send-reminders — email active subscribers who haven't picked their meals for the
// orderable week yet (a few days before the Friday cutoff). In-app reminder already exists (/app/menu
// shows "no meals picked"); this is the email nudge. SMS reminder is added once A2P clears.
// Admin-gated. ?dry=1 to preview who would be reminded without sending.
import { ok, fail } from '../../_lib/respond.js';
import { one, all } from '../../_lib/db.js';
import { orderableWeek, isLocked, cutoffForWeek } from '../../_lib/menu.js';
import { ghlSend } from '../../_lib/ghl.js';

const ACTIVE = ['active', 'trialing', 'past_due']; // paused customers don't order, don't nag them

export async function onRequestPost(context) {
  const { request, env } = context;
  const token = request.headers.get('x-admin-token') || '';
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return fail(401, 'unauthorized', 'Bad admin token.');

  const dry = new URL(request.url).searchParams.get('dry') === '1';
  const week = orderableWeek();
  if (isLocked(week)) return ok({ skipped: 'week_already_locked', week_of: week });

  const cutoff = cutoffForWeek(week).toISOString().slice(0, 10);
  const subs = await all(env.DB,
    `SELECT s.id, s.meals_per_week, c.id AS customer_id, c.email, c.first_name, c.ghl_contact_id
     FROM subscriptions s JOIN customers c ON c.id = s.customer_id
     WHERE s.status IN (${ACTIVE.map(() => '?').join(',')})`, ...ACTIVE);

  const summary = { week_of: week, candidates: 0, reminded: 0, already_picked: 0, no_contact: 0, dry };
  for (const sub of subs) {
    if (!(sub.meals_per_week > 0)) continue; // legacy 0-meal subs: not orderable yet, skip
    const picked = await one(env.DB,
      `SELECT COALESCE(SUM(qty),0) AS n FROM meal_selections WHERE subscription_id = ? AND week_of = ?`, sub.id, week);
    if ((picked?.n || 0) === sub.meals_per_week) { summary.already_picked++; continue; }
    summary.candidates++;
    if (dry) continue;
    const hi = sub.first_name ? ` ${sub.first_name}` : '';
    const html =
      `<p>Hey${hi},</p>` +
      `<p>Your Gainz Train meals for the week of ${week} aren't picked yet. Choose your ${sub.meals_per_week} meals before Friday (${cutoff}) or we'll repeat last week for you.</p>` +
      `<p><a href="${(env.APP_BASE_URL || '')}/app/menu/">Pick my meals</a></p>`;
    const status = await ghlSend(env, {
      customerId: sub.customer_id, contactId: sub.ghl_contact_id,
      channel: 'email', template: 'meal_reminder', subject: 'Pick your Gainz Train meals', body: html,
    });
    if (status === 'sent') summary.reminded++; else summary.no_contact++;
  }
  return ok({ summary });
}
