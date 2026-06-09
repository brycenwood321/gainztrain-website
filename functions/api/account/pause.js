// POST /api/account/pause — pause the customer's subscription (no billing, no meals while paused).
// Stripe pause_collection=void is the source of truth; D1 mirrors it.
import { ok, fail } from '../../_lib/respond.js';
import { run, nowIso } from '../../_lib/db.js';
import { getSessionCustomer } from '../../_lib/auth.js';
import { stripe } from '../../_lib/stripe.js';
import { currentSub } from '../../_lib/account.js';
import { notify } from '../../_lib/notify.js';

export async function onRequestPost(context) {
  const auth = await getSessionCustomer(context);
  if (!auth) return fail(401, 'not_authenticated', 'Please log in.');
  const { env } = context;

  const sub = await currentSub(env, auth.customer.id, ['active', 'trialing', 'past_due']);
  if (!sub || !sub.stripe_subscription_id) return fail(400, 'no_active_sub', 'You have no active plan to pause.');
  if (sub.status === 'paused') return ok({ status: 'paused' });

  try {
    await stripe(env, 'POST', `subscriptions/${sub.stripe_subscription_id}`, { pause_collection: { behavior: 'void' } });
  } catch (e) {
    return fail(502, 'stripe_failed', String(e?.message || e).slice(0, 160));
  }
  const now = nowIso();
  await run(env.DB, `UPDATE subscriptions SET status='paused', paused_at=?, updated_at=? WHERE id=?`, now, now, sub.id);
  try { await notify(env, auth.customer, 'paused'); } catch { /* non-fatal */ }
  return ok({ status: 'paused' });
}
