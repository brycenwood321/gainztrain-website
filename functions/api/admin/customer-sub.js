// POST /api/admin/customer-sub — OWNER-only management of ANY customer's subscription from the /ops
// Customers tab. Mirrors the self-service /api/account/* actions but targets a body-supplied customer_id
// instead of the session customer. Every action is Stripe-first (Stripe is the source of truth; D1 mirrors),
// so it is a real billing change, not a database-only flag. Owner-gated via requireOwner.
//   Body { customer_id, action, meals? }  action ∈ pause | resume | cancel | uncancel | set_tier
import { ok, fail, readJson } from '../../_lib/respond.js';
import { one, run, nowIso } from '../../_lib/db.js';
import { requireOwner } from '../../_lib/admin.js';
import { getSessionCustomer } from '../../_lib/auth.js';
import { stripe } from '../../_lib/stripe.js';
import { currentSub, findMealItem } from '../../_lib/account.js';
import { tierForMeals, ensureStripePrice, MIN_MEALS, MAX_MEALS } from '../../_lib/plans.js';
import { orderableWeek, isLocked, upcomingSunday } from '../../_lib/menu.js';
import { notify } from '../../_lib/notify.js';
import { ownerNotify } from '../../_lib/owner_notify.js';
import { moveToBillingDay, anchorForNextDelivery } from '../../_lib/billing_day.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const denied = await requireOwner(context);
  if (denied) return denied;

  const body = await readJson(request);
  const customerId = String(body.customer_id || '');
  const action = String(body.action || '');
  if (!customerId) return fail(400, 'no_customer', 'customer_id is required.');

  const customer = await one(env.DB, `SELECT * FROM customers WHERE id = ?`, customerId);
  if (!customer) return fail(404, 'not_found', 'Customer not found.');

  // Who performed this (for the audit trail) — an owner session or the admin token.
  let actor = 'admin-token';
  try { const s = await getSessionCustomer(context); if (s) actor = s.customer.email || s.customer.id; } catch { /* token path */ }
  const who = customer.first_name || customer.email || customerId;
  const tag = (msg) => `${msg} — by ${actor}`;

  try {
    switch (action) {
      // ── PAUSE (no billing, no meals) ──
      case 'pause': {
        const sub = await currentSub(env, customerId, ['active', 'trialing', 'past_due']);
        if (!sub || !sub.stripe_subscription_id) return fail(400, 'no_active_sub', 'No active plan to pause.');
        if (sub.status === 'paused') return ok({ status: 'paused' });
        // Same lock-awareness as account/pause.js — see the long comment there. pause_collection
        // 'void' cancels the pending invoice, so pausing between the Saturday lock and Saturday
        // billing gives away a week of food that is already in the cook.
        const lockedOrder = await one(env.DB,
          `SELECT week_of, total_meals FROM orders WHERE customer_id = ? AND week_of = ? AND status = 'locked'`,
          customerId, upcomingSunday());
        await stripe(env, 'POST', `subscriptions/${sub.stripe_subscription_id}`, { pause_collection: { behavior: 'void' } });
        const now = nowIso();
        await run(env.DB, `UPDATE subscriptions SET status='paused', paused_at=?, updated_at=? WHERE id=?`, now, now, sub.id);
        try { await notify(env, customer, 'paused', { lockedWeek: lockedOrder?.week_of || null, lockedMeals: lockedOrder?.total_meals || 0 }); } catch { /* non-fatal */ }
        try {
          await ownerNotify(env, 'owner_paused',
            tag(`${who}'s plan PAUSED (${sub.meals_per_week} meals/wk)`)
              + (lockedOrder
                ? ` — ⚠️ PAUSED AFTER THE LOCK: ${lockedOrder.total_meals} meals for ${lockedOrder.week_of} are already in the cook and pausing VOIDS that invoice. Collect for this week by hand.`
                : ''),
            { entity: `customer:${customerId}` });
        } catch { /* non-fatal */ }
        return ok({ status: 'paused', week_already_locked: !!lockedOrder, locked_week: lockedOrder?.week_of || null });
      }

      // ── RESUME (un-pause) ──
      // ⚠️ THIS MUST STAY IN STEP WITH functions/api/account/resume.js — see the long comment there.
      // Until 2026-08-12 this twin cleared only `pause_collection`, so the Luis Soto failure was
      // fully reproducible through the ops dashboard even after the customer-facing path was fixed:
      // a queued cancellation stayed armed, and the re-anchor that MOVES the period end would have
      // rescheduled that cancellation onto the billing Saturday. It also never re-anchored, so a
      // phone-in customer resumed by staff came back on their pre-pause weekday, permanently off the
      // Saturday cycle. Phone-in customers are exactly the ones routed through here.
      case 'resume': {
        const sub = await currentSub(env, customerId, ['paused']);
        if (!sub || !sub.stripe_subscription_id) return fail(400, 'no_paused_sub', 'No paused plan to resume.');

        // Pause and cancel are INDEPENDENT Stripe flags. Resuming means "keep sending me meals", so
        // a queued cancellation is called off — never silently: the customer gets the 'reactivated'
        // notice and the owner alert names it, so a mistaken resume is visible and objectable.
        const before = await stripe(env, 'GET', `subscriptions/${sub.stripe_subscription_id}`);
        const clearedPendingCancel = before?.cancel_at_period_end === true;

        await stripe(env, 'POST', `subscriptions/${sub.stripe_subscription_id}`, {
          pause_collection: '',
          ...(clearedPendingCancel ? { cancel_at_period_end: false } : {}),
        });
        let live = await stripe(env, 'GET', `subscriptions/${sub.stripe_subscription_id}`);

        // Bring them back onto the SATURDAY billing day; a paused sub keeps its pre-pause anchor.
        // Non-fatal — a Stripe hiccup must not block the resume (rebill-anchor can re-align later).
        try {
          const moved = await moveToBillingDay(env, sub.stripe_subscription_id, anchorForNextDelivery());
          if (moved.applied) live = await stripe(env, 'GET', `subscriptions/${sub.stripe_subscription_id}`);
        } catch { /* non-fatal */ }

        const status = live?.status === 'active' ? 'active' : (live?.status || 'active');
        const now = nowIso();
        // current_period_end lives on the subscription ITEMS; the flat field can be null with no error.
        const periodEnd = live?.items?.data?.[0]?.current_period_end || live?.current_period_end;
        await run(env.DB,
          `UPDATE subscriptions SET status=?, paused_at=NULL, cancel_at_period_end=?, current_period_end=?, updated_at=? WHERE id=?`,
          status,
          clearedPendingCancel ? 0 : (sub.cancel_at_period_end || 0),
          periodEnd ? new Date(periodEnd * 1000).toISOString() : sub.current_period_end,
          now, sub.id);
        try { await notify(env, customer, 'resumed'); } catch { /* non-fatal */ }
        if (clearedPendingCancel) {
          try { await notify(env, customer, 'reactivated'); } catch { /* non-fatal */ }
        }
        try {
          await ownerNotify(env, 'owner_resumed',
            tag(`${who}'s plan RESUMED (${sub.meals_per_week} meals/wk)`)
              + (clearedPendingCancel ? ' — this also CALLED OFF a pending cancellation, so they bill again on their next Saturday.' : ''),
            { entity: `customer:${customerId}` });
        } catch { /* non-fatal */ }
        return ok({ status, cancellation_cleared: clearedPendingCancel });
      }

      // ── CANCEL / UNCANCEL (at period end; keeps meals through the paid period) ──
      case 'cancel':
      case 'uncancel': {
        const undo = action === 'uncancel';
        const sub = await currentSub(env, customerId, ['active', 'trialing', 'past_due', 'paused']);
        if (!sub || !sub.stripe_subscription_id) return fail(400, 'no_active_sub', 'No active plan to cancel.');
        await stripe(env, 'POST', `subscriptions/${sub.stripe_subscription_id}`, { cancel_at_period_end: !undo });
        const live = await stripe(env, 'GET', `subscriptions/${sub.stripe_subscription_id}`);
        const now = nowIso();
        const end = live?.current_period_end ? new Date(live.current_period_end * 1000).toISOString() : sub.current_period_end;
        await run(env.DB, `UPDATE subscriptions SET cancel_at_period_end=?, current_period_end=?, updated_at=? WHERE id=?`,
          undo ? 0 : 1, end, now, sub.id);
        try { await notify(env, customer, undo ? 'reactivated' : 'canceled', { ends: end }); } catch { /* non-fatal */ }
        try {
          await ownerNotify(env, undo ? 'owner_reactivated' : 'owner_canceled',
            undo ? tag(`${who}'s cancellation UNDONE (${sub.meals_per_week} meals/wk)`)
                 : tag(`${who} CANCELED — ${sub.meals_per_week} meals/wk, ends ${String(end).slice(0, 10)}`),
            { entity: `customer:${customerId}` });
        } catch { /* non-fatal */ }
        return ok({ cancel_at_period_end: !undo, ends: end });
      }

      // ── SET TIER (change meals/week; Stripe proration matches the account flow) ──
      case 'set_tier': {
        const meals = Number(body.meals);
        const tier = tierForMeals(meals);
        if (!tier) return fail(400, 'invalid_meals', `Choose between ${MIN_MEALS} and ${MAX_MEALS} meals per week.`);
        const sub = await currentSub(env, customerId, ['active', 'trialing', 'past_due', 'paused']);
        if (!sub || !sub.stripe_subscription_id) return fail(400, 'no_active_sub', 'No active plan to change.');
        if (sub.meals_per_week === meals) return ok({ meals, tier: tier.key });

        const weekOf = orderableWeek();
        const order = await one(env.DB, `SELECT status FROM orders WHERE subscription_id = ? AND week_of = ?`, sub.id, weekOf);
        const weekLocked = isLocked(weekOf) || (order && order.status === 'locked');
        const proration = weekLocked ? 'none' : 'create_prorations';

        const stripeSub = await stripe(env, 'GET', `subscriptions/${sub.stripe_subscription_id}`);
        const mealItem = findMealItem(stripeSub);
        if (!mealItem) return fail(409, 'meal_item_missing', 'Could not find the meal line on this subscription.');
        const priceId = await ensureStripePrice(env, tier);
        await stripe(env, 'POST', `subscription_items/${mealItem.id}`, {
          price: priceId, quantity: meals, proration_behavior: proration,
        }, `gt_admtier_${mealItem.id}_${meals}_${proration}_${stripeSub.current_period_start || ''}`);
        await stripe(env, 'POST', `subscriptions/${sub.stripe_subscription_id}`, { metadata: { meals_per_week: String(meals), tier: tier.key } });
        await run(env.DB, `UPDATE subscriptions SET meals_per_week=?, tier_price_cents=?, updated_at=? WHERE id=?`,
          meals, tier.perMealCents, nowIso(), sub.id);
        if (!weekLocked && order) {
          try {
            await run(env.DB, `DELETE FROM meal_selections WHERE subscription_id = ? AND week_of = ?`, sub.id, weekOf);
            await run(env.DB, `DELETE FROM orders WHERE subscription_id = ? AND week_of = ?`, sub.id, weekOf);
          } catch { /* non-fatal */ }
        }
        try { await notify(env, customer, 'tier_changed', { meals, perMealCents: tier.perMealCents, nextWeek: !!weekLocked }); } catch { /* non-fatal */ }
        try { await ownerNotify(env, 'owner_tier_changed', tag(`${who} plan changed ${sub.meals_per_week} → ${meals} meals/wk`), { entity: `customer:${customerId}` }); } catch { /* non-fatal */ }
        return ok({ meals, tier: tier.key, per_meal_cents: tier.perMealCents, effective: weekLocked ? 'next_week' : 'this_week' });
      }

      default:
        return fail(400, 'bad_action', 'action must be pause, resume, cancel, uncancel, or set_tier.');
    }
  } catch (e) {
    return fail(502, 'stripe_failed', String(e?.message || e).slice(0, 200));
  }
}
