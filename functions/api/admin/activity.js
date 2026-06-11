// GET /api/admin/activity — the ops "Activity" feed: a reverse-chronological stream of everything that
// happened (customer actions, billing events, cron jobs). Reads audit_log, which every state change
// writes to. Admin-gated.
//   ?limit=N   (default 100, max 300)
//   ?since=ISO (optional: only rows at/after this timestamp)
import { ok, fail } from '../../_lib/respond.js';
import { requireStaffOrAdmin } from '../../_lib/admin.js';
import { all } from '../../_lib/db.js';

export async function onRequestGet(context) {
  const denied = await requireStaffOrAdmin(context);
  if (denied) return denied;
  const u = new URL(context.request.url);
  const limit = Math.min(300, Math.max(1, parseInt(u.searchParams.get('limit'), 10) || 100));
  const since = u.searchParams.get('since');

  const rows = since
    ? await all(context.env.DB,
        `SELECT id, at, actor, entity, action, detail_json FROM audit_log WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?`,
        since, limit)
    : await all(context.env.DB,
        `SELECT id, at, actor, entity, action, detail_json FROM audit_log ORDER BY at DESC, id DESC LIMIT ?`,
        limit);

  // Pull the human summary out of detail_json when present (owner_* rows carry one); otherwise the
  // action + entity is the description. Keep the raw detail for drill-down.
  const events = rows.map((r) => {
    let summary = null, detail = null;
    try { const d = JSON.parse(r.detail_json || '{}'); summary = d.summary || null; detail = d; } catch { /* leave null */ }
    return { id: r.id, at: r.at, actor: r.actor, entity: r.entity, action: r.action, summary, detail };
  });
  return ok({ events, count: events.length });
}
