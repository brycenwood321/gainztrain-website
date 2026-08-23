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
// Owners (Brycen/Jayson/Marissa/Alyssa) are INCLUDED by default, his call 2026-08-22: they collect
// real meals like anybody else and the reason they were skipped at first was a guess, not a rule.
// "If we have open meals" needs no special handling — the query below only returns people with a live
// pickup order for the week, so an owner who did not order cannot be pulled in. ?exclude_owners=1
// restores the old behaviour.
import { ok, fail } from '../../_lib/respond.js';
import { requireAdmin } from '../../_lib/admin.js';
import { all } from '../../_lib/db.js';
import { upcomingSunday } from '../../_lib/menu.js';
import { notify, smsRollout } from '../../_lib/notify.js';

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
const EVENTS = { change: 'pickup_change', reminder: 'pickup_reminder' };

export async function onRequestPost(context) {
  const { request, env } = context;
  const denied = await requireAdmin(context);
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const dry = params.get('dry') === '1';
  const excludeOwners = params.get('exclude_owners') === '1';
  // Single-recipient smoke test. The whole point is to prove BOTH legs land before 12 people get it,
  // so the per-channel results below are returned rather than collapsed into a count.
  const only = params.get('only');
  // Hard cap on customers per request. A Pages Function gets ~50 subrequests, and each customer can
  // cost three GHL fetches (ensure-contact + email + sms). Fifteen at once overran it on
  // 2026-08-22: the Worker threw 1101 PART WAY THROUGH, after real messages had gone out. The
  // script loops until `remaining` is 0, and dedup makes each extra pass cheap.
  // Two per request. Each customer really costs ~10 subrequests once every D1 write is counted
  // (claim, prefs, phone lookup, contact upsert, two sends, two send-logs, feed row), and 4 still
  // reached the ~50 ceiling. The script loops, so a low number costs passes, not outcomes.
  const max = Math.max(1, Math.min(10, parseInt(params.get('max') || '2', 10) || 2));
  // Finish a partial delivery: ?channel=sms sends only the text, so somebody who already has the
  // email is not mailed twice to deliver one message.
  const channel = params.get('channel');
  const channels = channel === 'sms' ? ['sms'] : (channel === 'email' ? ['email'] : null);
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
  // Who still needs something, decided in SQL so a pass costs nothing for people already done.
  //
  // Two different questions depending on mode, and getting this wrong double-sends:
  //   full send  -> anyone WITHOUT a live claim for this event+week
  //   channel=sms -> anyone WITHOUT a successfully sent SMS row for this template. The claim filter is
  //                  wrong here by definition: these customers were claimed by the full send, that is
  //                  exactly why their text is missing. Matching on the delivered row instead means
  //                  the nine who already got a text are excluded and cannot receive a second one.
  const exclusion = channels
    ? `AND NOT EXISTS (
          SELECT 1 FROM comms_log cl
           WHERE cl.customer_id = o.customer_id AND cl.template = ?
             AND cl.channel = ? AND cl.ghl_status = 'sent')`
    : `AND NOT EXISTS (
          SELECT 1 FROM comms_log cl
           WHERE cl.dedup_key = ? || o.customer_id || ? AND cl.ghl_status = 'claimed')`;
  const exclusionArgs = channels ? [tpl, channels[0]] : [`pickup:${eventKey}:`, `:${week}`];

  const rows = await all(env.DB,
    `SELECT DISTINCT o.customer_id, c.email, c.first_name, c.last_name, c.phone,
            c.ghl_contact_id, c.is_owner
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
      WHERE o.week_of = ?
        AND o.status NOT IN ('skipped_paused','skipped_canceled')
        AND COALESCE(o.delivery_method, c.delivery_method) = 'pickup'
        ${exclusion}
      ORDER BY c.first_name, c.last_name`,
    week, ...exclusionArgs);

  const summary = {
    week_of: week, event: tpl, when, dry,
    candidates: 0, sent: 0, deduped: 0, failed: 0, skipped_owner: 0, skipped_no_email: 0, owners_included: 0,
  };
  const recipients = [];

  // Filter first, then send in small concurrent batches.
  //
  // ⚠️ This was a sequential for-loop and it cost a failed send on 2026-08-22. Fifteen customers x
  // (email + SMS) is up to thirty GHL round-trips back to back, which runs for about a minute — and
  // Cloudflare ABORTS a Worker the moment the client disconnects. One blip on Brycen's wifi killed the
  // run with no response and no way to tell how far it had got. Batching cuts the wall time to a few
  // seconds, which is short enough that a blip has nothing to interrupt.
  //
  // Concurrency stays low on purpose: notify() writes D1 rows and GHL rate-limits, and this is not a
  // hot path worth pushing.
  const targets = [];
  for (const r of rows) {
    if (only && r.customer_id !== only) continue;
    if (r.is_owner === 1 && excludeOwners) { summary.skipped_owner++; continue; }
    if (!r.email) { summary.skipped_no_email++; continue; }
    summary.candidates++;
    if (r.is_owner === 1) summary.owners_included++;
    const entry = {
      name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
      email: r.email,
      sms: r.phone ? 'yes' : 'no phone',
      owner: r.is_owner === 1 || undefined,
    };
    recipients.push(entry);
    targets.push({ row: r, entry });
  }

  // Work through everyone, but stop launching REAL sends once `max` of them have happened.
  //
  // A deduped customer costs one D1 insert that conflicts and returns — zero GHL fetches — so they are
  // free to walk past and must NOT count against the cap. Counting attempts instead of sends was a bug
  // in the first version of this fix: the first five names are already deduped, so every pass would
  // have chewed on the same five and never reached anybody new.
  summary.remaining = 0;
  if (!dry) {
    const BATCH = 5;
    let attemptedUpTo = 0;
    for (let i = 0; i < targets.length; i += BATCH) {
      if (summary.sent + summary.failed >= max) break;
      const slice = targets.slice(i, i + BATCH);
      attemptedUpTo = i + slice.length;
      await Promise.all(slice.map(async ({ row: r, entry }) => {
        const cust = {
          id: r.customer_id, email: r.email, first_name: r.first_name,
          ghl_contact_id: r.ghl_contact_id,
        };
        let res;
        try {
          // One notice per customer per week per event, whatever happens upstream.
          // A channel-restricted run gets its OWN dedup key, so finishing the SMS leg cannot be
          // blocked by (or clobber) the claim from the original full send.
          const dedupKey = channels
            ? `pickup:${eventKey}:${channels.join('+')}:${r.customer_id}:${week}`
            : `pickup:${eventKey}:${r.customer_id}:${week}`;
          res = await notify(env, cust, tpl, { firstName: r.first_name, when, weekOf: week },
            { dedupKey, channels });
        } catch (e) {
          res = { ok: false, reason: `threw: ${e && e.message}` };
        }
        // Should be rare now that the query excludes claimed customers — a non-zero count here means
        // a concurrent run claimed them between the query and the send, which is exactly what the
        // dedupKey exists to make harmless.
        if (res.deduped) summary.deduped++;
        else if (res.ok) summary.sent++;
        else summary.failed++;
        // Per-channel truth. `sent: 15` with every sms leg missing is a false green, and this system
        // has been bitten by exactly that before.
        entry.result = res.deduped ? 'deduped' : (res.ok ? 'ok' : (res.reason || 'failed'));
        entry.channels = (res.results || []).map((x) => `${x.channel || x.type || '?'}:${x.ok === false ? 'FAIL' : 'ok'}`);
      }));
    }
    summary.remaining = Math.max(0, targets.length - attemptedUpTo);
  }

  summary.sms_gate = String(env.SMS_AUTH_ENABLED) === 'true' ? 'on' : 'OFF (email only)';
  // Which texts are live at all. Brycen's call 2026-08-22 was to switch on the pickup texts ONLY, so
  // a preview that cannot show the blast radius is not a preview.
  summary.sms_rollout = smsRollout();
  return ok({ summary, recipients });
}
