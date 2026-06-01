// POST /api/account/cancel — cancel at the end of the current paid period (keeps meals through
// what they already paid for). Body { undo: true } reverses a pending cancellation.
import { ok, fail, readJson } from '../../_lib/respond.js';
import { run, nowIso } from '../../_lib/db.js';
import { getSessionCustomer } from '../../_lib/auth.js';
import { stripe } from '../../_lib/stripe.js';
import { currentSub } from '../../_lib/account.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = await getSessionCustomer(context);
  if (!auth) return fail(401, 'not_authenticated', 'Please log in.');

  const undo = (await readJson(request)).undo === true;
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
  await run(env.DB, `UPDATE subscriptions SET cancel_at_period_end=?, current_period_end=?, updated_at=? WHERE id=?`,
    undo ? 0 : 1, end, now, sub.id);
  return ok({ cancel_at_period_end: !undo, ends: end });
}
