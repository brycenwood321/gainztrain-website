// POST /api/admin/set-origin — flip a customer's subscription between 'legacy' and 'app'. Admin-token
// only. origin='app' means the weekly cron (reminders + Saturday lock/auto-fill) manages this sub and
// the customer can pick/manage meals in /app; 'legacy' means it's hand-managed (cron skips it).
//   Body { email, origin?='app' }
import { ok, fail, readJson } from '../../_lib/respond.js';
import { requireAdmin } from '../../_lib/admin.js';
import { one, all, run, nowIso } from '../../_lib/db.js';
import { normEmail } from '../../_lib/validate.js';

const LIVE = ['active', 'trialing', 'past_due', 'paused'];

export async function onRequestPost(context) {
  const { env } = context;
  const denied = await requireAdmin(context);
  if (denied) return denied;

  const body = await readJson(context.request);
  const email = normEmail(body.email);
  if (!email) return fail(400, 'invalid_email', 'Valid email required.');
  const origin = body.origin === 'legacy' ? 'legacy' : 'app';

  const cust = await one(env.DB, `SELECT id, first_name FROM customers WHERE email = ?`, email);
  if (!cust) return fail(404, 'not_found', 'No customer with that email.');

  // Update their live subscription(s).
  const subs = await all(env.DB,
    `SELECT id, status, meals_per_week, origin FROM subscriptions WHERE customer_id = ? AND status IN (${LIVE.map(() => '?').join(',')})`,
    cust.id, ...LIVE);
  if (!subs.length) return fail(400, 'no_live_sub', 'That customer has no active subscription to migrate.');

  const now = nowIso();
  for (const s of subs) {
    await run(env.DB, `UPDATE subscriptions SET origin=?, updated_at=? WHERE id=?`, origin, now, s.id);
  }
  try { await run(env.DB, `INSERT INTO audit_log (at, actor, entity, action, detail_json) VALUES (?, 'admin', ?, 'set_origin', ?)`,
    now, `customer:${cust.id}`, JSON.stringify({ email, origin, subs: subs.length })); } catch { /* non-fatal */ }

  return ok({ customer_id: cust.id, email, origin, subscriptions_updated: subs.length });
}
