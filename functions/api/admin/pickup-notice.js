// POST /api/admin/pickup-notice — tell this week's PICKUP customers where and when to collect.
//
// Built 2026-08-22, when pickup moved off Brycen's and Jayson's houses onto a 45-minute window at the
// kitchen. Two shapes, same recipient set:
//   ?event=change    the announcement (Saturday) — "it moves, here is the new window, miss it and $10"
//   ?event=reminder  the Sunday-morning last call before the window opens
//
// Deliberately modelled on send-reminders.js rather than posting into GHL directly: going through
// notify() is what buys the dedupKey (a double-click or a retried cron cannot re-blast anyone), the
// SMS leg, the comms_log row and the PREF_CLASS check. GHL only ever receives a finished string.
//
// ?dry=1 previews the exact recipient list and sends nothing. ALWAYS dry-run first — this is one of
// the few endpoints that reaches every customer at once.
//
// Owners are skipped by default (is_owner), because Brycen and Jayson do not need to be told where
// their own kitchen is. ?include_owners=1 overrides for testing.
import { ok, fail } from '../../_lib/respond.js';
import { requireAdmin } from '../../_lib/admin.js';
import { all } from '../../_lib/db.js';
import { upcomingSunday } from '../../_lib/menu.js';
import { notify } from '../../_lib/notify.js';

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
const EVENTS = { change: 'pickup_change', reminder: 'pickup_reminder' };

export async function onRequestPost(context) {
  const { request, env } = context;
  const denied = await requireAdmin(context);
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const dry = params.get('dry') === '1';
  const includeOwners = params.get('include_owners') === '1';
  const eventKey = params.get('event') || 'change';
  const tpl = EVENTS[eventKey];
  if (!tpl) return fail(400, 'bad_event', `event must be one of: ${Object.keys(EVENTS).join(', ')}`);

  const weekParam = params.get('week');
  if (weekParam && !WEEK_RE.test(weekParam)) return fail(400, 'bad_week', 'week must be YYYY-MM-DD.');
  const week = weekParam || upcomingSunday();

  // The customer's own word for the day, rendered here so the template never guesses.
  const when = params.get('when') || (eventKey === 'reminder' ? 'today' : 'tomorrow');

  // Anyone with a live order this week whose fulfilment is pickup. Same status exclusions as the cook
  // list: if we are not cooking for them, we are not telling them when to collect.
  const rows = await all(env.DB,
    `SELECT DISTINCT o.customer_id, c.email, c.first_name, c.last_name, c.phone,
            c.ghl_contact_id, c.is_owner
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
      WHERE o.week_of = ?
        AND o.status NOT IN ('skipped_paused','skipped_canceled')
        AND COALESCE(o.delivery_method, c.delivery_method) = 'pickup'
      ORDER BY c.first_name, c.last_name`,
    week);

  const summary = {
    week_of: week, event: tpl, when, dry,
    candidates: 0, sent: 0, deduped: 0, failed: 0, skipped_owner: 0, skipped_no_email: 0,
  };
  const recipients = [];

  for (const r of rows) {
    if (r.is_owner === 1 && !includeOwners) { summary.skipped_owner++; continue; }
    if (!r.email) { summary.skipped_no_email++; continue; }
    summary.candidates++;
    recipients.push({
      name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
      email: r.email,
      sms: r.phone ? 'yes' : 'no phone',
    });
    if (dry) continue;

    const cust = {
      id: r.customer_id, email: r.email, first_name: r.first_name,
      ghl_contact_id: r.ghl_contact_id,
    };
    // One notice per customer per week per event, whatever happens upstream.
    const res = await notify(env, cust, tpl, { firstName: r.first_name, when, weekOf: week },
      { dedupKey: `pickup:${eventKey}:${r.customer_id}:${week}` });
    if (res.deduped) summary.deduped++;
    else if (res.ok) summary.sent++;
    else summary.failed++;
  }

  return ok({ summary, recipients });
}
