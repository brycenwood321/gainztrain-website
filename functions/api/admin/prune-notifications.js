// POST /api/admin/prune-notifications — storage hygiene for the in-app feed. Deletes notification rows
// older than 120 days (the feed only ever displays the most recent 30 per customer). Admin-gated, safe
// to run repeatedly; wired to the weekly cron. comms_log 'claimed' rows are NOT touched (they're the
// idempotency ledger — deleting them would allow re-sends).
import { ok, fail } from '../../_lib/respond.js';
import { requireAdmin } from '../../_lib/admin.js';
import { run, addDaysIso } from '../../_lib/db.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const denied = await requireAdmin(context);
  if (denied) return denied;
  const r = await run(env.DB, `DELETE FROM notifications WHERE created_at < ?`, addDaysIso(-120));
  // Also prune stale rate-limit counters (windows are minutes; anything a day old is dead).
  let rl = { meta: { changes: 0 } };
  try { rl = await run(env.DB, `DELETE FROM rate_limits WHERE window_start < ?`, addDaysIso(-1)); } catch { /* table may not exist yet */ }
  return ok({ deleted: r?.meta?.changes || 0, rate_limits_pruned: rl?.meta?.changes || 0 });
}
