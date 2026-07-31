// GET|POST /api/admin/payment-order-audit — reconcile MONEY against FOOD for a delivery week.
// Owner-or-admin-token gated (the cron uses the token). Read-only: it never mutates, only reports.
//
// WHY THIS EXISTS: the kitchen and the bank read different sources. `lock-week` decides who gets cooked
// for from D1 `orders`/`subscriptions`; billing happens in Stripe. When those two drift, nobody notices
// until a customer complains — and it has already happened twice:
//   - Jameson (2026-07-10): paid, but the lock cron had already run a day early (the DOW bug), so no
//     order row was ever created. He paid for a week the kitchen never saw.
//   - Jeferson (2026-07-23): paid $119, order sat 'pending' and never locked; meals were made by hand
//     off-system, so every dashboard showed him as un-served.
// Both were caught by accident, weeks later. This is the check that catches the next one on the day.
//
// THREE FAILURES IT LOOKS FOR:
//   locked_but_unpaid    — in the cook list, but the subscription is past_due/unpaid or is carrying an
//                          open (uncollected) invoice. We're about to buy food for someone not paying.
//   paying_but_not_locked— an active, un-paused, app-origin subscriber with NO locked order for the
//                          week. They expect meals; the kitchen has no idea they exist. (The Jameson
//                          shape.) Also catches orders stuck in 'pending' like Jeferson's.
//   locked_while_paused  — a paused subscription that somehow has a locked order: cooking for free.
//
// Deliberately D1-only, ZERO Stripe calls: Cloudflare caps subrequests per invocation, and this has to
// keep working when there are 200 customers, not 12.
import { ok, fail } from '../../_lib/respond.js';
import { requireStaffOrAdmin } from '../../_lib/admin.js';
import { all } from '../../_lib/db.js';
import { upcomingSunday, isLocked, cutoffForWeek } from '../../_lib/menu.js';
import { ownerNotify } from '../../_lib/owner_notify.js';

// How far back an unpaid invoice still counts as "this customer owes us". Two weekly cycles.
const OPEN_INVOICE_WINDOW_DAYS = 15;

// Subscription states that mean money is NOT flowing even though meals might be.
const NOT_PAYING = new Set(['past_due', 'unpaid', 'incomplete']);

async function audit(env, weekOf) {
  const since = new Date(Date.now() - OPEN_INVOICE_WINDOW_DAYS * 86400 * 1000).toISOString();

  // ⚠️ THIS CHECK IS ONLY MEANINGFUL AFTER THE WEEK HAS LOCKED. Before the Friday-midnight cutoff
  // nobody has a locked order yet — orders sit 'pending' by design — so running early reports EVERY
  // subscriber as "missing from the kitchen". The cron slots (Sat 13:00 + 17:00 UTC) are both after the
  // 07:30 UTC lock, but a human opening this mid-week would otherwise get a screen of false alarms,
  // and an alert people learn to ignore is worse than no alert.
  if (!isLocked(weekOf)) {
    return { week_of: weekOf, status: 'not_locked_yet', cooking_for: 0, issue_count: 0, issues: [],
      note: 'Ordering is still open for this week — mismatches cannot be judged until it locks.' };
  }

  const locked = await all(env.DB,
    `SELECT o.subscription_id, o.total_meals, o.upcharge_total_cents, o.delivery_method,
            s.status AS sub_status, s.meals_per_week,
            c.id AS customer_id, c.first_name, c.last_name, c.email, c.phone
       FROM orders o
       JOIN subscriptions s ON s.id = o.subscription_id
       JOIN customers c ON c.id = o.customer_id
      WHERE o.week_of = ? AND o.status = 'locked'`, weekOf);

  // Every invoice still awaiting money. 'open' = finalized but uncollected; 'uncollectible' = given up.
  const unpaidRows = await all(env.DB,
    `SELECT subscription_id, id, status, amount_due_cents, created_at
       FROM invoices
      WHERE status IN ('open','uncollectible') AND created_at >= ? AND subscription_id IS NOT NULL`, since);
  const unpaidBySub = new Map();
  for (const i of unpaidRows) {
    if (!unpaidBySub.has(i.subscription_id)) unpaidBySub.set(i.subscription_id, []);
    unpaidBySub.get(i.subscription_id).push(i);
  }

  const issues = [];

  // Cutoff has passed but NOTHING is locked → the lock cron did not run. That's one loud, actionable
  // failure, not N per-customer ones — and it's the exact shape of the day-of-week cron bug that closed
  // ordering early in July. Report it alone; every other check would just be downstream noise.
  if (locked.length === 0) {
    return { week_of: weekOf, status: 'lock_never_ran', cooking_for: 0, issue_count: 1,
      issues: [{ type: 'lock_never_ran', name: 'ALL CUSTOMERS', detail:
        `Ordering for ${weekOf} is past cutoff but NOT ONE order is locked — the lock cron did not run. Nobody will be cooked for. Run /api/admin/lock-week.` }] };
  }

  for (const o of locked) {
    const who = `${o.first_name || '?'} ${o.last_name || ''}`.trim();
    if (o.sub_status === 'paused') {
      issues.push({ type: 'locked_while_paused', name: who, email: o.email, customer_id: o.customer_id,
        meals: o.total_meals, detail: 'Paused subscription has a locked order — meals would be cooked with no billing.' });
      continue;
    }
    const owed = unpaidBySub.get(o.subscription_id) || [];
    const owedCents = owed.reduce((s, i) => s + (i.amount_due_cents || 0), 0);
    if (NOT_PAYING.has(o.sub_status) || owed.length) {
      issues.push({ type: 'locked_but_unpaid', name: who, email: o.email, phone: o.phone,
        customer_id: o.customer_id, meals: o.total_meals, sub_status: o.sub_status,
        open_invoices: owed.length, amount_owed: owedCents / 100,
        detail: `In the cook list for ${o.total_meals} meals but ${NOT_PAYING.has(o.sub_status) ? `subscription is ${o.sub_status}` : `carrying ${owed.length} unpaid invoice(s) totalling $${(owedCents / 100).toFixed(2)}`}.` });
    }
  }

  // The other direction: someone the kitchen has NO record of. Includes orders stuck in 'pending'
  // (never locked) — that's exactly how Jeferson's week went missing.
  //
  // ⚠️ created_at < cutoff IS REQUIRED, not a nicety. A subscription that started AFTER this week
  // locked could never have had an order for it — it's ordering for the NEXT week. Without this,
  // anyone who signs up on Saturday (post-lock, during the ordering blackout) is falsely reported as
  // missing from a cook list they were never meant to be on. Caught by running the check against the
  // 2026-07-26 week, which flagged Daniel and Destiny — both of whom signed up after it closed.
  const cutoffISO = cutoffForWeek(weekOf).toISOString();
  const missing = await all(env.DB,
    `SELECT s.id AS subscription_id, s.status AS sub_status, s.meals_per_week,
            c.id AS customer_id, c.first_name, c.last_name, c.email, c.phone,
            (SELECT o.status FROM orders o WHERE o.subscription_id = s.id AND o.week_of = ?) AS order_status
       FROM subscriptions s
       JOIN customers c ON c.id = s.customer_id
      WHERE s.status IN ('active','trialing','past_due')
        AND s.origin = 'app'
        AND s.created_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM orders o WHERE o.subscription_id = s.id AND o.week_of = ? AND o.status = 'locked')`,
    weekOf, cutoffISO, weekOf);

  for (const m of missing) {
    issues.push({ type: 'paying_but_not_locked', name: `${m.first_name || '?'} ${m.last_name || ''}`.trim(),
      email: m.email, phone: m.phone, customer_id: m.customer_id, meals: m.meals_per_week,
      sub_status: m.sub_status, order_status: m.order_status || 'none',
      detail: m.order_status
        ? `Order exists but is '${m.order_status}', not locked — the kitchen will not cook it.`
        : 'Active subscriber with no order at all for this week.' });
  }

  return { week_of: weekOf, cooking_for: locked.length, issue_count: issues.length, issues };
}

export async function onRequest(context) {
  const { request, env } = context;
  const denied = await requireStaffOrAdmin(context);
  if (denied) return denied;

  const weekOf = new URL(request.url).searchParams.get('week_of') || upcomingSunday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekOf)) return fail(400, 'bad_week', 'week_of must be YYYY-MM-DD.');

  const report = await audit(env, weekOf);

  // Alert the owners only when something is actually wrong, and only on the cron (POST) path — a human
  // opening this in the dashboard shouldn't fire a text at everyone.
  if (request.method === 'POST' && report.issue_count > 0) {
    const lines = report.issues.slice(0, 12).map((i) => `• ${i.name}: ${i.detail}`).join('\n');
    try {
      await ownerNotify(env, 'owner_payment_order_mismatch',
        `⚠️ ${report.issue_count} billing/kitchen mismatch(es) for the ${weekOf} delivery — check before shopping:\n${lines}`,
        { entity: `week:${weekOf}` });
    } catch { /* alerting must never fail the check */ }
  }

  return ok(report);
}
