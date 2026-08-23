// GET  /api/admin/comms-audit?template=pickup_change   — who actually received it
// POST /api/admin/comms-audit?template=pickup_change&release_orphans=1 — free stuck claims for retry
//
// Built 2026-08-22 after a send died on the Workers subrequest cap mid-flight.
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

async function audit(env, template) {
  const rows = await all(env.DB,
    `SELECT c.id, c.first_name, c.last_name, c.email,
            MAX(CASE WHEN cl.channel = 'notify' AND cl.ghl_status = 'claimed' THEN 1 ELSE 0 END) AS claimed,
            MAX(CASE WHEN cl.channel = 'email'  AND cl.ghl_status = 'sent'    THEN 1 ELSE 0 END) AS email_sent,
            MAX(CASE WHEN cl.channel = 'sms'    AND cl.ghl_status = 'sent'    THEN 1 ELSE 0 END) AS sms_sent,
            MAX(CASE WHEN cl.ghl_status = 'failed' THEN 1 ELSE 0 END) AS any_failed
       FROM comms_log cl
       JOIN customers c ON c.id = cl.customer_id
      WHERE cl.template = ?
      GROUP BY c.id
      ORDER BY c.first_name, c.last_name`,
    template);

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

export async function onRequestGet(context) {
  const denied = await requireAdmin(context); if (denied) return denied;
  const template = new URL(context.request.url).searchParams.get('template');
  if (!template) return json({ ok: false, error: 'template required' }, 400);
  return json({ ok: true, ...(await audit(context.env, template)) }, 200);
}

export async function onRequestPost(context) {
  const denied = await requireAdmin(context); if (denied) return denied;
  const params = new URL(context.request.url).searchParams;
  const template = params.get('template');
  if (!template) return json({ ok: false, error: 'template required' }, 400);
  const report = await audit(context.env, template);
  if (params.get('release_orphans') !== '1') return json({ ok: true, ...report, released: 0 }, 200);

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
  return json({ ok: true, ...report, released, voided_at: stamp,
                note: 'Re-run the send. Voided customers will now receive it; delivered ones stay deduped.' }, 200);
}
