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
// 08:00Z lock and that Sunday's delivery. Mon-Fri no order is locked yet, because locking is what
// the Saturday cron does.
//
// Why it matters: `pause_collection: 'void'` VOIDS any invoice Stripe finalizes after the pause. Before
// 2026-09-06 billing ran seven hours AFTER the lock, so a pause in that window erased the money for
// food already committed (Jeferson 07-30, $119; Destiny 09-05, $91.50). Since 2026-09-06 the lock
// CHARGES the week before it locks it (api/admin/lock-week.js), so a pause after the lock cannot void
// a paid week: this week still comes and it is paid, the pause starts next week. `charge_status` on
// the order row says which case this is, so the owner alert can say the truth instead of guessing.
//
// Deliberately does NOT block the pause. A customer must always be able to stop their plan.
async function lockedWeekForCustomer(env, customerId) {
  const week = upcomingSunday();
  try {
    const row = await one(env.DB,
      `SELECT week_of, total_meals, charge_status FROM orders
        WHERE customer_id = ? AND week_of = ? AND status = 'locked'`,
      customerId, week);
    return row || null;
  } catch { return null; }
}

function afterLockNote(lockedOrder) {
  if (!lockedOrder) return '';
  const paid = lockedOrder.charge_status === 'paid' || lockedOrder.charge_status === 'comp';
  if (paid) {
    return ` (paused AFTER the lock: ${lockedOrder.total_meals} meals for ${lockedOrder.week_of} are already PAID and still come; the pause starts the following week)`;
  }
  return ` (⚠️ PAUSED AFTER THE LOCK with charge_status ${lockedOrder.charge_status || 'none'}: ${lockedOrder.total_meals} meals for ${lockedOrder.week_of} are in the cook and this week's money is NOT confirmed. Check the invoice and collect by hand if it is void.)`;
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
      `${c.first_name || c.email} paused their plan (${sub.meals_per_week} meals/wk)` + afterLockNote(lockedOrder),
      { entity: `customer:${c.id}` });
  } catch { /* non-fatal */ }
  return ok({ status: 'paused', week_already_locked: !!lockedOrder, locked_week: lockedOrder?.week_of || null });
}
