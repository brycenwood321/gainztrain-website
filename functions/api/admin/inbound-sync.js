// POST /api/admin/inbound-sync?max=8&all=1 — refresh customers.last_inbound_* from GoHighLevel.
//
// Who: customers with a GHL contact id and a subscription that is live, paused or scheduled to cancel
// (the people whose replies decide the Monday email), whose cache is older than 20 hours. ?all=1 drops
// the subscription filter. Small passes on purpose: two GHL reads per customer against a Pages
// Function's subrequest ceiling (see pickup-notice.js for the 2026-08-22 overrun). The cron loops
// until `remaining` is 0, like the pickup reminder does.
//
// Never throws past a customer: a failed read leaves that row's cache untouched and is reported in
// `failed` with the reason, so a bad token shows up as 20 failures, not as 20 customers who "never
// replied" (memory: log silence is not evidence).
import { ok } from '../../_lib/respond.js';
import { requireAdmin } from '../../_lib/admin.js';
import { all, run, nowIso } from '../../_lib/db.js';
import { ghlLastInbound } from '../../_lib/ghl.js';

export const STALE_HOURS = 20;

export async function onRequestPost(context) {
  const { request, env } = context;
  const denied = await requireAdmin(context);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const max = Math.max(1, Math.min(15, parseInt(params.get('max') || '8', 10) || 8));
  const everyone = params.get('all') === '1';
  const staleBefore = new Date(Date.now() - STALE_HOURS * 3600 * 1000).toISOString();

  const subFilter = everyone ? '' :
    `AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.customer_id = c.id
                   AND (s.status IN ('active','trialing','past_due','paused') OR s.cancel_at_period_end = 1))`;
  const rows = await all(env.DB,
    `SELECT c.id, c.email, c.ghl_contact_id FROM customers c
      WHERE c.ghl_contact_id IS NOT NULL AND c.ghl_contact_id != ''
        AND (c.inbound_synced_at IS NULL OR c.inbound_synced_at < ?) ${subFilter}
      ORDER BY c.inbound_synced_at ASC NULLS FIRST, c.created_at DESC`, staleBefore);

  const summary = { candidates: rows.length, synced: 0, with_reply: 0, failed: 0, failures: [], remaining: 0 };
  const batch = rows.slice(0, max);
  for (const r of batch) {
    const res = await ghlLastInbound(env, r.ghl_contact_id);
    if (!res.ok) {
      summary.failed++;
      if (summary.failures.length < 5) summary.failures.push({ email: r.email, reason: res.reason });
      continue;
    }
    const now = nowIso();
    if (res.last) {
      await run(env.DB,
        `UPDATE customers SET last_inbound_at=?, last_inbound_text=?, last_inbound_channel=?, inbound_synced_at=?, updated_at=? WHERE id=?`,
        res.last.at, res.last.text, res.last.channel, now, now, r.id);
      summary.with_reply++;
    } else {
      await run(env.DB, `UPDATE customers SET inbound_synced_at=?, updated_at=? WHERE id=?`, now, now, r.id);
    }
    summary.synced++;
  }
  summary.remaining = Math.max(0, rows.length - batch.length) + summary.failed;
  return ok(summary);
}
