// GET  /api/admin/comms-audit?template=pickup_change   — who actually received it
// POST /api/admin/comms-audit?template=pickup_change&release_orphans=1 — free stuck claims for retry
//
// Built 2026-08-22 after a send died on the Workers subrequest cap mid-flight.
//
// ⚠️ TIME WINDOW, added 2026-08-31. This endpoint used to return every matching row FOR ALL TIME,
// and that is what let "are this week's comms healthy?" be answered yes from last week's rows while
// the menu blast had never sent once (lesson an-undated-audit-proves-nothing). An endpoint that
// answers a time-bounded question must not accept an unbounded query, so:
//   ?since=7          days back (DEFAULT: 7)
//   ?since=2026-08-24 explicit ISO date
//   ?since=all        deliberately unbounded, and the response says so
// Every response echoes the window it actually used.
//
// THE PROBLEM THIS SOLVES. notify() claims a comms_log row (ghl_status='claimed') BEFORE it calls
// GHL, so a concurrent retry cannot double-send. It releases that claim if GHL *reports* a failure —
// but not if the Worker is KILLED, because dead code releases nothing. A customer can therefore end
// up claimed-but-never-sent, and every future retry reports them as a healthy "deduped". At-most-once
// silently degrades to never-sent, and the summary looks perfect while somebody gets no message.
//
// Ground truth is the per-channel rows ghlSend writes: channel 'email'/'sms' with ghl_status 'sent'.
// The claim row is channel 'notify'. An orphan is a claim with no successful channel row.
//
// ⚠️ Releasing a claim VOIDS it, it does not delete it. The row stays for the audit trail with its
// dedup_key tombstoned (which is what frees the unique index) and ghl_status='claim_voided'. Nothing
// here destroys history — house rule is to move things aside, never delete them.
import { json } from '../../_lib/respond.js';
import { all, run, nowIso } from '../../_lib/db.js';
import { requireAdmin } from '../../_lib/admin.js';

// since=null means the caller explicitly asked for all history; the window string travels with every
// response so a reader can never mistake unbounded rows for this week's.
function parseSince(params) {
  const raw = (params.get('since') || '7').trim();
  if (raw === 'all') return { sinceIso: null, window: 'all history (explicit ?since=all)' };
  let iso;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) iso = raw;
  else {
    const days = Math.min(3650, Math.max(0.01, parseFloat(raw) || 7));
    iso = new Date(Date.now() - days * 86400000).toISOString();
  }
  return { sinceIso: iso, window: `since ${iso}` };
}

async function audit(env, template, sinceIso) {
  const rows = await all(env.DB,
    `SELECT c.id, c.first_name, c.last_name, c.email,
            MAX(CASE WHEN cl.channel = 'notify' AND cl.ghl_status = 'claimed' THEN 1 ELSE 0 END) AS claimed,
            MAX(CASE WHEN cl.channel = 'email'  AND cl.ghl_status = 'sent'    THEN 1 ELSE 0 END) AS email_sent,
            MAX(CASE WHEN cl.channel = 'sms'    AND cl.ghl_status = 'sent'    THEN 1 ELSE 0 END) AS sms_sent,
            MAX(CASE WHEN cl.ghl_status = 'failed' THEN 1 ELSE 0 END) AS any_failed
       FROM comms_log cl
       JOIN customers c ON c.id = cl.customer_id
      WHERE cl.template = ? AND (? IS NULL OR cl.sent_at >= ?)
      GROUP BY c.id
      ORDER BY c.first_name, c.last_name`,
    template, sinceIso, sinceIso);

  const delivered = [], orphans = [], failed = [];
  for (const r of rows) {
    const who = { id: r.id, name: `${r.first_name || ''} ${r.last_name || ''}`.trim(), email: r.email,
                  email_sent: !!r.email_sent, sms_sent: !!r.sms_sent };
    if (r.email_sent || r.sms_sent) delivered.push(who);
    else if (r.claimed) orphans.push(who);          // claimed, nothing ever left the building
    if (r.any_failed && !(r.email_sent || r.sms_sent)) failed.push(who);
  }
  return { template, delivered, orphans, failed,
           counts: { delivered: delivered.length, orphans: orphans.length, failed: failed.length } };
}

// ?detail=<customer_id> dumps the raw comms_log rows for one person. Aggregates hid the answer once
// already: a 'queued_no_token' row (GHL contact could not be resolved) is neither 'sent' nor 'failed',
// so it vanished from both the delivered list and the failure count.
async function detail(env, template, customerId, sinceIso) {
  return await all(env.DB,
    `SELECT channel, ghl_status, contact_id, sent_at, dedup_key
       FROM comms_log WHERE customer_id = ? AND template = ? AND (? IS NULL OR sent_at >= ?) ORDER BY sent_at`,
    customerId, template, sinceIso, sinceIso);
}

export async function onRequestGet(context) {
  const denied = await requireAdmin(context); if (denied) return denied;
  const params = new URL(context.request.url).searchParams;
  const template = params.get('template');
  if (!template) return json({ ok: false, error: 'template required' }, 400);
  const { sinceIso, window } = parseSince(params);
  const who = params.get('detail');
  if (who) return json({ ok: true, window, customer_id: who, rows: await detail(context.env, template, who, sinceIso) }, 200);
  return json({ ok: true, window, ...(await audit(context.env, template, sinceIso)) }, 200);
}

export async function onRequestPost(context) {
  const denied = await requireAdmin(context); if (denied) return denied;
  const params = new URL(context.request.url).searchParams;
  const template = params.get('template');
  if (!template) return json({ ok: false, error: 'template required' }, 400);
  const { sinceIso, window } = parseSince(params);
  const report = await audit(context.env, template, sinceIso);
  const relChan = params.get('release_channel');
  if (relChan) {
    // The window scopes releases too: voiding a months-old claim would queue a months-late message.
    const stuck = (await all(context.env.DB,
      `SELECT DISTINCT cl.customer_id, c.first_name, c.last_name
         FROM comms_log cl JOIN customers c ON c.id = cl.customer_id
        WHERE cl.template = ? AND cl.ghl_status = 'claimed'
          AND (? IS NULL OR cl.sent_at >= ?)
          AND cl.dedup_key LIKE ?
          AND NOT EXISTS (
            SELECT 1 FROM comms_log s
             WHERE s.customer_id = cl.customer_id AND s.template = ?
               AND s.channel = ? AND s.ghl_status = 'sent')`,
      template, sinceIso, sinceIso, `%:${relChan}:%`, template, relChan)) || [];
    const ts = nowIso();
    let freed = 0;
    for (const p of stuck) {
      const r = await run(context.env.DB,
        `UPDATE comms_log
            SET dedup_key = dedup_key || ':voided:' || ?, ghl_status = 'claim_voided'
          WHERE customer_id = ? AND template = ? AND ghl_status = 'claimed' AND dedup_key LIKE ?`,
        ts, p.customer_id, template, `%:${relChan}:%`);
      freed += r?.meta?.changes || 0;
    }
    return json({ ok: true, window, channel: relChan, freed,
                  people: stuck.map((p) => `${p.first_name || ''} ${p.last_name || ''}`.trim()),
                  note: `Re-run the ${relChan} send; these will now be reached.` }, 200);
  }

  if (params.get('release_orphans') !== '1') return json({ ok: true, window, ...report, released: 0 }, 200);

  // ?release_channel=sms frees a claim on ONE leg. A customer who got the email but not the text is
  // not an "orphan" — they have a delivered row — yet their SMS claim still blocks the retry that
  // would finish the job. Voiding it is the only way to reach them without re-sending the email.
  // Void ONLY the claims of customers with no successful channel row. A delivered customer's claim is
  // left intact, which is what stops the retry from messaging them twice.
  const stamp = nowIso();
  let released = 0;
  for (const o of report.orphans) {
    const r = await run(context.env.DB,
      `UPDATE comms_log
          SET dedup_key = dedup_key || ':voided:' || ?,
              ghl_status = 'claim_voided'
        WHERE customer_id = ? AND template = ? AND channel = 'notify' AND ghl_status = 'claimed'`,
      stamp, o.id, template);
    released += r?.meta?.changes || 0;
  }
  return json({ ok: true, window, ...report, released, voided_at: stamp,
                note: 'Re-run the send. Voided customers will now receive it; delivered ones stay deduped.' }, 200);
}
