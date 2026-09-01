// POST /api/admin/alert  { summary, lines?: string[] }
//
// Admin-gated hand into ownerNotify('owner_health_alert'). Exists so machinery OUTSIDE the Pages
// runtime (the cron Worker's post-send verification, gt_comms_watch.py on the Mac) can page the
// owners through the same channel the daily digest uses, instead of each growing its own sender.
//
// Honest about its own limits: this path rides GHL. When GHL itself is down (the 7-day outage
// case) this alert goes nowhere, which is exactly why the Mac watchdog's PRIMARY channel is its
// exit code (guardian + session digest) and this is only its secondary. The audit_log row that
// ownerNotify always writes still lands either way, so the attempt is on record.
import { ok, fail, readJson } from '../../_lib/respond.js';
import { requireAdmin } from '../../_lib/admin.js';
import { ownerNotify } from '../../_lib/owner_notify.js';
import { str } from '../../_lib/validate.js';

export async function onRequestPost(context) {
  const denied = await requireAdmin(context); if (denied) return denied;
  const body = await readJson(context.request);
  const summary = str(body.summary).slice(0, 300);
  if (!summary) return fail(400, 'no_summary', 'summary is required.');
  const lines = Array.isArray(body.lines) ? body.lines.map((l) => String(l).slice(0, 300)).slice(0, 20) : [];
  const res = await ownerNotify(context.env, 'owner_health_alert', summary, { entity: 'system', lines });
  return ok({ delivered: res });
}
