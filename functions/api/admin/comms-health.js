// GET /api/admin/comms-health?since=1 is the one window-bounded answer to "are comms working?"
//
// Built 2026-08-31 as part of the response to the 7-day outage (2026-08-24 to 08-30), in which
// every send failed for a week and nothing noticed. This endpoint is the single place that turns
// comms_log into a verdict a watchdog can act on. It reports; thresholds live with the callers:
//   - gt_comms_watch.py on the Mac (independent of GHL, so it still fires when the token is dead)
//   - daily-digest.js server-side (pages the owners via ownerNotify when its health block trips)
//
// ?since takes days (default 1) or an ISO date. There is deliberately NO unbounded mode here:
// a health question is always about a window (lesson an-undated-audit-proves-nothing).
import { json } from '../../_lib/respond.js';
import { all, one } from '../../_lib/db.js';
import { requireAdmin } from '../../_lib/admin.js';
import { smsRollout } from '../../_lib/notify.js';

export async function onRequestGet(context) {
  const denied = await requireAdmin(context); if (denied) return denied;
  const { env } = context;
  const params = new URL(context.request.url).searchParams;

  const raw = (params.get('since') || '1').trim();
  let sinceIso;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) sinceIso = raw;
  else {
    const days = Math.min(90, Math.max(0.01, parseFloat(raw) || 1));
    sinceIso = new Date(Date.now() - days * 86400000).toISOString();
  }

  // Real delivery attempts are channel email/sms. 'notify' rows are dedup claims, not sends.
  const totals = await one(env.DB,
    `SELECT
       SUM(CASE WHEN ghl_status = 'sent' THEN 1 ELSE 0 END) AS sent,
       SUM(CASE WHEN ghl_status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN ghl_status = 'queued_no_token' THEN 1 ELSE 0 END) AS queued_no_token,
       COUNT(*) AS attempts
     FROM comms_log
     WHERE channel IN ('email','sms') AND sent_at >= ?`, sinceIso);

  const byTemplate = await all(env.DB,
    `SELECT template, channel,
            SUM(CASE WHEN ghl_status = 'sent' THEN 1 ELSE 0 END) AS sent,
            SUM(CASE WHEN ghl_status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM comms_log
      WHERE channel IN ('email','sms') AND sent_at >= ?
      GROUP BY template, channel ORDER BY failed DESC, sent DESC`, sinceIso);

  // Claims stuck longer than an hour with no delivered leg: the claimed-but-never-sent failure mode
  // the comms-audit endpoint exists to repair.
  const hourAgo = new Date(Date.now() - 3600000).toISOString();
  const stuckClaims = await one(env.DB,
    `SELECT COUNT(*) AS n FROM comms_log cl
      WHERE cl.channel = 'notify' AND cl.ghl_status = 'claimed'
        AND cl.sent_at >= ? AND cl.sent_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM comms_log s
           WHERE s.customer_id = cl.customer_id AND s.template = cl.template
             AND s.channel IN ('email','sms') AND s.ghl_status = 'sent'
             AND s.sent_at >= ?)`, sinceIso, hourAgo, sinceIso);

  // Latest recorded failure detail (written by ghl.js on every failed send since 2026-08-31), so the
  // watchdog's alert can say WHY without another query.
  const lastError = await one(env.DB,
    `SELECT at, detail_json FROM audit_log
      WHERE actor = 'ghl' AND action = 'ghl_send_failed' AND at >= ?
      ORDER BY at DESC LIMIT 1`, sinceIso);

  const sent = totals?.sent || 0;
  const failed = totals?.failed || 0;
  const attempts = (totals?.attempts || 0);
  const failureRate = attempts > 0 ? failed / attempts : 0;

  return json({
    ok: true,
    window: `since ${sinceIso}`,
    totals: {
      attempts, sent, failed,
      queued_no_token: totals?.queued_no_token || 0,
      failure_rate: Math.round(failureRate * 1000) / 1000,
    },
    stuck_claims: stuckClaims?.n || 0,
    by_template: byTemplate,
    last_failure: lastError ? { at: lastError.at, detail: (() => { try { return JSON.parse(lastError.detail_json); } catch { return lastError.detail_json; } })() } : null,
    sms_rollout: smsRollout(),
  }, 200);
}
