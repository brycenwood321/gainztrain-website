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
  let clearedPendingCancel = false;
  try {
    // ⚠️ A PENDING CANCELLATION MUST BE CLEARED HERE — 2026-08-08, Luis Soto.
    // Pause and cancel are independent flags in Stripe, and resume used to clear only the pause. He
    // canceled at 3:44pm, paused at 3:45pm, resumed at 5:47pm, and the app told him he was resumed
    // while `cancel_at_period_end` stayed armed underneath. Worse, the re-anchor below moves the
    // period end — so resume actively RESCHEDULED his cancellation onto the next billing Saturday.
    // At 9:00am Saturday Stripe hit that date and canceled him instead of charging, after the 1:30am
    // lock had already put 14 meals into the cook. $119 of food went out unpaid.
    //
    // Resuming a plan means "keep sending me meals", so clearing the cancellation is the honest read
    // of the intent — and leaving the two flags contradicting each other is what caused the loss.
    // It is never done silently: the customer gets the 'reactivated' notice below (the same one the
    // explicit undo-cancel path sends) and the owners are told, so nobody is quietly put back on a
    // paying plan they meant to leave.
    const before = await stripe(env, 'GET', `subscriptions/${sub.stripe_subscription_id}`);
    clearedPendingCancel = before?.cancel_at_period_end === true;

    // Clearing pause_collection resumes billing. Re-fetch to get the real status back.
    await stripe(env, 'POST', `subscriptions/${sub.stripe_subscription_id}`, {
      pause_collection: '',
      ...(clearedPendingCancel ? { cancel_at_period_end: false } : {}),
    });
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
  // Stripe relocated current_period_end onto the subscription ITEMS; the flat field can be null with no
  // error thrown (the same relocation that silently broke invoice.subscription). Read items first, fall
  // back to the flat field, and only then to whatever D1 already had.
  const periodEnd = live?.items?.data?.[0]?.current_period_end || live?.current_period_end;
  await run(env.DB,
    `UPDATE subscriptions SET status=?, paused_at=NULL, cancel_at_period_end=?, current_period_end=?, updated_at=? WHERE id=?`,
    status,
    clearedPendingCancel ? 0 : (sub.cancel_at_period_end || 0),
    periodEnd ? new Date(periodEnd * 1000).toISOString() : sub.current_period_end,
    now, sub.id);
  try { await notify(env, auth.customer, 'resumed'); } catch { /* non-fatal */ }
  // Say it out loud when a queued cancellation was called off. Same notice the explicit undo-cancel
  // path sends, so the customer can object if resuming was not what they meant.
  if (clearedPendingCancel) {
    try { await notify(env, auth.customer, 'reactivated'); } catch { /* non-fatal */ }
  }
  try {
    const c = auth.customer;
    await ownerNotify(env, 'owner_resumed',
      `${c.first_name || c.email} resumed their plan (${sub.meals_per_week} meals/wk)`
        + (clearedPendingCancel ? ' — this also CALLED OFF a pending cancellation, so they bill again on their next Saturday.' : ''),
      { entity: `customer:${c.id}` });
  } catch { /* non-fatal */ }
  return ok({ status, cancellation_cleared: clearedPendingCancel });
}
