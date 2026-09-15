// POST /api/account/cancel — cancel at the end of the current paid period (keeps meals through
// what they already paid for). Body { undo: true } reverses a pending cancellation.
// Body (optional, ignored on undo): { reason: <code from _lib/reasons.js>, reason_text }. A missing reason
// is stored as 'declined' and never blocks the cancel.
import { ok, fail, readJson } from '../../_lib/respond.js';
import { readReason, reasonLabel } from '../../_lib/reasons.js';
import { run, nowIso } from '../../_lib/db.js';
import { getSessionCustomer } from '../../_lib/auth.js';
import { stripe } from '../../_lib/stripe.js';
import { currentSub } from '../../_lib/account.js';
import { notify } from '../../_lib/notify.js';
import { ownerNotify } from '../../_lib/owner_notify.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = await getSessionCustomer(context);
  if (!auth) return fail(401, 'not_authenticated', 'Please log in.');

  const body = await readJson(request);
  const undo = body.undo === true;
  const reason = undo ? null : readReason(body);
  const sub = await currentSub(env, auth.customer.id, ['active', 'trialing', 'past_due', 'paused']);
  if (!sub || !sub.stripe_subscription_id) return fail(400, 'no_active_sub', 'You have no active plan to cancel.');

  let live;
  try {
    await stripe(env, 'POST', `subscriptions/${sub.stripe_subscription_id}`, { cancel_at_period_end: !undo });
    live = await stripe(env, 'GET', `subscriptions/${sub.stripe_subscription_id}`);
  } catch (e) {
    return fail(502, 'stripe_failed', String(e?.message || e).slice(0, 160));
  }
  const now = nowIso();
  const end = live?.current_period_end ? new Date(live.current_period_end * 1000).toISOString() : sub.current_period_end;
  if (undo) {
    await run(env.DB, `UPDATE subscriptions SET cancel_at_period_end=0, current_period_end=?, updated_at=? WHERE id=?`, end, now, sub.id);
  } else {
    // Reason rides the same statement as the cancel flag (migration 0029).
    await run(env.DB,
      `UPDATE subscriptions SET cancel_at_period_end=1, current_period_end=?, updated_at=?,
              reason_kind='cancel', reason_code=?, reason_text=?, reason_at=? WHERE id=?`,
      end, now, reason.code, reason.text, now, sub.id);
  }
  try { await notify(env, auth.customer, undo ? 'reactivated' : 'canceled', { ends: end }); } catch { /* non-fatal */ }
  try {
    const c = auth.customer;
    await ownerNotify(env, undo ? 'owner_reactivated' : 'owner_canceled',
      undo ? `${c.first_name || c.email} undid their cancellation (${sub.meals_per_week} meals/wk)`
           : `${c.first_name || c.email} canceled — ${sub.meals_per_week} meals/wk, ends ${String(end).slice(0, 10)}, reason: ${reasonLabel(reason.code)}` +
             (reason.text ? ` "${reason.text}"` : ''),
      { entity: `customer:${c.id}`, reason: reason ? reason.code : null, reason_text: reason ? reason.text : null });
  } catch { /* non-fatal */ }
  return ok({ cancel_at_period_end: !undo, ends: end, reason: reason ? reason.code : null });
}
