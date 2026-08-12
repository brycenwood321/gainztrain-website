// POST /api/account/pause — pause the customer's subscription (no billing, no meals while paused).
// Stripe pause_collection=void is the source of truth; D1 mirrors it.
import { ok, fail } from '../../_lib/respond.js';
import { run, nowIso } from '../../_lib/db.js';
import { getSessionCustomer } from '../../_lib/auth.js';
import { stripe } from '../../_lib/stripe.js';
import { currentSub } from '../../_lib/account.js';
import { notify } from '../../_lib/notify.js';
import { ownerNotify } from '../../_lib/owner_notify.js';
import { one } from '../../_lib/db.js';
import { upcomingSunday } from '../../_lib/menu.js';

// Is this customer's NEXT delivery already locked into the cook? True only between the Saturday
// 07:30Z lock and that Sunday's delivery — Mon-Fri no order is locked yet, because locking is what
// the Saturday cron does.
//
// This matters because `pause_collection: 'void'` VOIDS the pending invoice. Pause inside that window
// and the meals are already committed to the kitchen while the money is cancelled: food out, $0 in,
// and the order row still reads 'locked' so nobody downstream can tell. That is exactly the shape of
// Jeferson's 2026-07-30 loss ($119). Unlike tier.js:34 and address.js:45, which both consult
// isLocked() before changing anything, pause consulted nothing at all.
//
// Deliberately does NOT block the pause — a customer must always be able to stop their plan. It makes
// the consequence visible instead: the customer is told this week still comes, and the owners get an
// alert naming the money at risk so someone can collect for food that has already been made.
async function lockedWeekForCustomer(env, customerId) {
  const week = upcomingSunday();
  try {
    const row = await one(env.DB,
      `SELECT week_of, total_meals FROM orders
        WHERE customer_id = ? AND week_of = ? AND status = 'locked'`,
      customerId, week);
    return row || null;
  } catch { return null; }
}

export async function onRequestPost(context) {
  const auth = await getSessionCustomer(context);
  if (!auth) return fail(401, 'not_authenticated', 'Please log in.');
  const { env } = context;

  const sub = await currentSub(env, auth.customer.id, ['active', 'trialing', 'past_due']);
  if (!sub || !sub.stripe_subscription_id) return fail(400, 'no_active_sub', 'You have no active plan to pause.');
  if (sub.status === 'paused') return ok({ status: 'paused' });

  const lockedOrder = await lockedWeekForCustomer(env, auth.customer.id);

  try {
    await stripe(env, 'POST', `subscriptions/${sub.stripe_subscription_id}`, { pause_collection: { behavior: 'void' } });
  } catch (e) {
    return fail(502, 'stripe_failed', String(e?.message || e).slice(0, 160));
  }
  const now = nowIso();
  await run(env.DB, `UPDATE subscriptions SET status='paused', paused_at=?, updated_at=? WHERE id=?`, now, now, sub.id);
  try { await notify(env, auth.customer, 'paused', { lockedWeek: lockedOrder?.week_of || null, lockedMeals: lockedOrder?.total_meals || 0 }); } catch { /* non-fatal */ }
  try {
    const c = auth.customer;
    await ownerNotify(env, 'owner_paused',
      `${c.first_name || c.email} paused their plan (${sub.meals_per_week} meals/wk)`
        + (lockedOrder
          ? ` — ⚠️ PAUSED AFTER THE LOCK: ${lockedOrder.total_meals} meals for ${lockedOrder.week_of} are already in the cook and pausing VOIDS that invoice. Collect for this week by hand.`
          : ''),
      { entity: `customer:${c.id}` });
  } catch { /* non-fatal */ }
  return ok({ status: 'paused', week_already_locked: !!lockedOrder, locked_week: lockedOrder?.week_of || null });
}
