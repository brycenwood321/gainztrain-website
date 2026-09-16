// GET /api/admin/retention: the Gainz Train retention number. Owner or ADMIN_TOKEN gated, read-only.
//
// Built 2026-09-16 because the app redesign named retention as the decision it serves and nothing in
// the system produced a GT retention figure (retention-weekly is Summit only). The Mac-side
// gainz-train/scripts/gt_retention.py calls this weekly and writes the dated file the plan's
// baseline reads from. Everything here is counted from D1 rows; nothing is inferred from Stripe.
//
//   ?week=YYYY-MM-DD   the delivery Sunday to measure picks against (default: the orderable week)
//   ?days=N            the trailing window for new / paused / cancelled counts (default 7)
//
// Definitions (say them in the file, so a reader never guesses):
//   paying          subs with status active or trialing, origin app ('trialing' is how Stripe
//                   re-anchors to Saturday, the plan is live and will be charged)
//   past_due        status past_due (still cookable unless an invoice is open, decide.js)
//   paused          status paused
//   new             subs created inside the window
//   paused_in       reason_kind = 'pause' with reason_at inside the window (the 0029 columns),
//                   OR paused_at inside the window for rows that predate 0029
//   cancelled_in    reason_kind = 'cancel' with reason_at inside the window
//   picked          paying subs with any qty > 0 selection for `week`
//   picked_early    of those, the first selection row for that week was created before the
//                   Wednesday 17:00 UTC reminder (week_of minus 4 days, 17:00Z), i.e. they did
//                   not need the nudge. This is the plan's leading indicator.
import { ok } from '../../_lib/respond.js';
import { requireOwner } from '../../_lib/admin.js';
import { all, one } from '../../_lib/db.js';
import { orderableWeek } from '../../_lib/menu.js';

export const PAYING = ['active', 'trialing'];

export function reminderCutoffIso(weekOf) {
  // Wednesday 17:00 UTC before the Sunday `weekOf` (cron/worker.js: hour 17, day WED).
  const d = new Date(`${weekOf}T17:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 4);
  return d.toISOString();
}

export async function onRequestGet(context) {
  const denied = await requireOwner(context);
  if (denied) return denied;
  const { env } = context;
  const u = new URL(context.request.url);
  const week = /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get('week') || '') ? u.searchParams.get('week') : orderableWeek();
  const days = Math.min(90, Math.max(1, parseInt(u.searchParams.get('days'), 10) || 7));
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const byStatus = await all(env.DB,
    `SELECT status, COUNT(*) AS n FROM subscriptions WHERE origin = 'app' GROUP BY status`);
  const counts = Object.fromEntries(byStatus.map((r) => [r.status, r.n]));
  const paying = PAYING.reduce((s, k) => s + (counts[k] || 0), 0);

  const newIn = await one(env.DB,
    `SELECT COUNT(*) AS n FROM subscriptions WHERE origin = 'app' AND created_at >= ?`, since);
  const pausedIn = await one(env.DB,
    `SELECT COUNT(*) AS n FROM subscriptions WHERE origin = 'app'
       AND ((reason_kind = 'pause' AND reason_at >= ?) OR (reason_kind IS NULL AND paused_at >= ?))`, since, since);
  const cancelledIn = await one(env.DB,
    `SELECT COUNT(*) AS n FROM subscriptions WHERE origin = 'app' AND reason_kind = 'cancel' AND reason_at >= ?`, since);

  const reminderAt = reminderCutoffIso(week);
  const picks = await all(env.DB,
    `SELECT s.id, MIN(m.created_at) AS first_pick
       FROM subscriptions s
       JOIN meal_selections m ON m.subscription_id = s.id AND m.week_of = ? AND m.qty > 0
      WHERE s.origin = 'app' AND s.status IN (${PAYING.map(() => '?').join(',')})
      GROUP BY s.id`, week, ...PAYING);
  const picked = picks.length;
  const pickedEarly = picks.filter((p) => p.first_pick && p.first_pick < reminderAt).length;

  const reasons = await all(env.DB,
    `SELECT reason_kind, reason_code, COUNT(*) AS n FROM subscriptions
      WHERE origin = 'app' AND reason_kind IS NOT NULL AND reason_at >= ?
      GROUP BY reason_kind, reason_code ORDER BY n DESC`, since);

  return ok({
    measured_at: new Date().toISOString(),
    week_of: week,
    window_days: days,
    window_since: since,
    paying,
    by_status: counts,
    new_in_window: newIn?.n || 0,
    paused_in_window: pausedIn?.n || 0,
    cancelled_in_window: cancelledIn?.n || 0,
    picked,
    picked_early: pickedEarly,
    picked_share: paying ? Math.round((picked / paying) * 1000) / 10 : null,
    picked_early_share: paying ? Math.round((pickedEarly / paying) * 1000) / 10 : null,
    reminder_cutoff: reminderAt,
    reasons_in_window: reasons,
    definitions: 'see functions/api/admin/retention.js header',
  });
}
