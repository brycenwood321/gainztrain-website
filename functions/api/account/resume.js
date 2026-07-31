// POST /api/account/resume — un-pause the customer's subscription (resume billing + meals).
import { ok, fail } from '../../_lib/respond.js';
import { run, nowIso } from '../../_lib/db.js';
import { getSessionCustomer } from '../../_lib/auth.js';
import { stripe } from '../../_lib/stripe.js';
import { currentSub } from '../../_lib/account.js';
import { notify } from '../../_lib/notify.js';
import { ownerNotify } from '../../_lib/owner_notify.js';
import { moveToBillingDay, anchorForNextDelivery } from '../../_lib/billing_day.js';

export async function onRequestPost(context) {
  const auth = await getSessionCustomer(context);
  if (!auth) return fail(401, 'not_authenticated', 'Please log in.');
  const { env } = context;

  const sub = await currentSub(env, auth.customer.id, ['paused']);
  if (!sub || !sub.stripe_subscription_id) return fail(400, 'no_paused_sub', 'You have no paused plan to resume.');

  let live;
  try {
    // Clearing pause_collection resumes billing. Re-fetch to get the real status back.
    await stripe(env, 'POST', `subscriptions/${sub.stripe_subscription_id}`, { pause_collection: '' });
    live = await stripe(env, 'GET', `subscriptions/${sub.stripe_subscription_id}`);
  } catch (e) {
    return fail(502, 'stripe_failed', String(e?.message || e).slice(0, 160));
  }
  // Bring them back onto the SATURDAY billing day. A paused sub keeps whatever anchor it had before the
  // pause, so without this a customer who paused on a Tuesday resumes billing on Tuesdays — permanently
  // off-cycle from the kitchen. They've paid for nothing upcoming, so they owe the next week they can
  // order for, charged the Saturday before it lands. Non-fatal: a Stripe hiccup here must not block the
  // resume itself (the bulk rebill-anchor endpoint can always re-align them).
  try {
    const moved = await moveToBillingDay(env, sub.stripe_subscription_id, anchorForNextDelivery());
    if (moved.applied) live = await stripe(env, 'GET', `subscriptions/${sub.stripe_subscription_id}`);
  } catch { /* non-fatal */ }

  const now = nowIso();
  const status = live?.status === 'active' ? 'active' : (live?.status || 'active');
  await run(env.DB, `UPDATE subscriptions SET status=?, paused_at=NULL, updated_at=? WHERE id=?`, status, now, sub.id);
  try { await notify(env, auth.customer, 'resumed'); } catch { /* non-fatal */ }
  try { const c = auth.customer; await ownerNotify(env, 'owner_resumed', `${c.first_name || c.email} resumed their plan (${sub.meals_per_week} meals/wk)`, { entity: `customer:${c.id}` }); } catch { /* non-fatal */ }
  return ok({ status });
}
