// POST /api/notifications/read — mark one ({id}) or all ({all:true}) of the customer's notifications
// read. Scoped to the session customer so one customer can never touch another's rows. Session-gated.
import { ok, fail, readJson } from '../../_lib/respond.js';
import { run, nowIso } from '../../_lib/db.js';
import { getSessionCustomer } from '../../_lib/auth.js';

export async function onRequestPost(context) {
  const auth = await getSessionCustomer(context);
  if (!auth) return fail(401, 'not_authenticated', 'Please log in.');
  const { request, env } = context;
  const raw = await readJson(request);
  const body = (raw && typeof raw === 'object') ? raw : {}; // null/primitive body → treat as empty
  const now = nowIso();

  if (body.all === true) {
    await run(env.DB, `UPDATE notifications SET read_at = ? WHERE customer_id = ? AND read_at IS NULL`, now, auth.customer.id);
    return ok({ marked: 'all' });
  }
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return fail(400, 'missing_id', 'Provide a notification id or {all:true}.');
  await run(env.DB, `UPDATE notifications SET read_at = ? WHERE id = ? AND customer_id = ? AND read_at IS NULL`, now, id, auth.customer.id);
  return ok({ marked: id });
}
