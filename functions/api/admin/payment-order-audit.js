// GET|POST /api/admin/payment-order-audit reconciles MONEY against FOOD for a delivery week.
// Owner-or-admin-token gated (the cron uses the token). Read-only: it never mutates, only reports.
//
// WHY THIS EXISTS: the kitchen and the bank read different sources. `lock-week` builds the cook list
// from D1; billing lives in Stripe. When they drift, food goes out unpaid and nobody finds out for
// weeks. It has happened four times:
//   - Jameson  (delivery 2026-07-12) paid, but the lock cron had run a day early so no order row existed.
//   - Jeferson (delivery 2026-07-26) paid $119 on 07-23, order stuck 'pending', never locked.
//   - Jeferson (delivery 2026-08-02) picked up 14 meals with NO payment: his 07-30 renewal invoice was VOIDED.
//   - Luis Soto (delivery 2026-08-09) 14 meals cooked with NO payment: he canceled, and the $0 invoice Stripe
//     raised when the subscription ended read as 'paid' + 'subscription_cycle', identical to a comp.
//     THIS CHECK COUNTED HIM AS PAID and reported the week clean apart from two others.
//
// THE LESSON FROM THAT LAST ONE, READ BEFORE CHANGING THIS FILE. The original version of this check
// asked "does this customer look unhealthy?" (subscription past_due/unpaid, or carrying an OPEN
// invoice). Jeferson passed every one of those: his subscription was 'active' and he had no open
// invoice, because the unpaid week had been VOIDED rather than left outstanding. The check reported
// "0 mismatches" on the very morning he collected $119 of unpaid food.
//
// So it no longer infers health. It answers the only question that matters, directly:
//     for THIS delivery week, does a PAID invoice exist that covers it?
// Health signals are proxies; a payment is the fact. Never regress this to a status check.
//
// HOW A PAYMENT MAPS TO A DELIVERY: see _lib/billing_day.js deliveryBoughtBy(). A signup buys the week
// that was orderable at checkout, a renewal (which now fires Saturday, AFTER the Friday cutoff) buys the
// imminent Sunday. That single helper is shared with the anchor logic so the two can never disagree.
//
// SCALING: one Stripe invoice-list call covers the WHOLE roster (paginated, capped), not one call per
// customer. Cloudflare caps subrequests per invocation and this must still work at 200 customers.
//
// The decision rules themselves live in _lib/decide.js so they can be unit tested without a D1
// binding or a Stripe key. This file is the I/O half: SQL, Stripe pagination, owner alerts.
// Tests: test/charge_and_feed.test.mjs.
import { ok, fail } from '../../_lib/respond.js';
import { requireStaffOrAdmin } from '../../_lib/admin.js';
import { all } from '../../_lib/db.js';
import { upcomingSunday, isLocked, cutoffForWeek } from '../../_lib/menu.js';
import { stripe } from '../../_lib/stripe.js';
import { ownerNotify } from '../../_lib/owner_notify.js';
import {
  paidWeeksFromInvoices, paymentCheckReady, emptyScan,
  notLockedReport, lockNeverRanReport, buildAuditReport,
} from '../../_lib/decide.js';

const LOOKBACK_DAYS = 45;   // far enough back to cover any prepaid week still in play
const MAX_PAGES = 5;        // 500 invoices, a hard stop so a bad filter cannot spin

// Pull every PAID invoice in the window, then hand the flat list to the pure mapper. Pages are
// appended in Stripe's order (newest first) so the mapper's first-write-wins keeps the most recent
// evidence for a week.
async function paidWeeksBySubscription(env) {
  const sinceTs = Math.floor((Date.now() - LOOKBACK_DAYS * 86400 * 1000) / 1000);
  const invoices = [];
  let startingAfter = null, pages = 0, truncated = false;

  while (pages < MAX_PAGES) {
    const params = { status: 'paid', limit: 100, created: { gte: sinceTs } };
    if (startingAfter) params.starting_after = startingAfter;
    const page = await stripe(env, 'GET', 'invoices', params);
    const rows = page.data || [];
    invoices.push(...rows);
    pages++;
    if (!page.has_more || !rows.length) break;
    startingAfter = rows[rows.length - 1].id;
    if (pages === MAX_PAGES && page.has_more) truncated = true;
  }
  return { ...paidWeeksFromInvoices(invoices), truncated };
}

async function audit(env, weekOf) {
  // ONLY MEANINGFUL AFTER THE WEEK LOCKS. Before the Friday-midnight cutoff orders sit 'pending' by
  // design, so running early reports every subscriber as missing. An alert people learn to ignore is
  // worse than no alert.
  if (!isLocked(weekOf)) return notLockedReport(weekOf);

  const locked = await all(env.DB,
    `SELECT o.subscription_id, o.total_meals, o.delivery_method,
            s.status AS sub_status, s.stripe_subscription_id,
            c.id AS customer_id, c.first_name, c.last_name, c.email, c.phone
       FROM orders o
       JOIN subscriptions s ON s.id = o.subscription_id
       JOIN customers c ON c.id = o.customer_id
      WHERE o.week_of = ? AND o.status = 'locked'`, weekOf);

  if (locked.length === 0) return lockNeverRanReport(weekOf);

  const billingSettled = paymentCheckReady(weekOf);
  const scan = billingSettled ? await paidWeeksBySubscription(env) : emptyScan();

  // The other direction: an active subscriber the kitchen has no locked order for. created_at <
  // cutoff is REQUIRED, because a subscription that started after this week locked is ordering for
  // the NEXT week and was never meant to be on this cook list.
  const cutoffISO = cutoffForWeek(weekOf).toISOString();
  const missing = await all(env.DB,
    `SELECT s.status AS sub_status, s.meals_per_week,
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

  return buildAuditReport({ weekOf, locked, missing, scan, billingSettled, maxPages: MAX_PAGES });
}

export async function onRequest(context) {
  const { request, env } = context;
  const denied = await requireStaffOrAdmin(context);
  if (denied) return denied;

  const weekOf = new URL(request.url).searchParams.get('week_of') || upcomingSunday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekOf)) return fail(400, 'bad_week', 'week_of must be YYYY-MM-DD.');

  const report = await audit(env, weekOf);

  // Alert owners only on the cron (POST) path and only when something is wrong. A human opening this
  // in the dashboard should never fire a text at everyone.
  if (request.method === 'POST' && report.issue_count > 0) {
    const lines = report.issues.slice(0, 12).map((i) => `• ${i.name}: ${i.detail}`).join('\n');
    try {
      await ownerNotify(env, 'owner_payment_order_mismatch',
        `⚠️ ${report.issue_count} billing/kitchen mismatch(es) for the ${weekOf} delivery, check before shopping:\n${lines}`,
        { entity: `week:${weekOf}` });
    } catch { /* alerting must never fail the check */ }
  }

  return ok(report);
}
