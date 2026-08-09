// GET|POST /api/admin/payment-order-audit — reconcile MONEY against FOOD for a delivery week.
// Owner-or-admin-token gated (the cron uses the token). Read-only: it never mutates, only reports.
//
// WHY THIS EXISTS: the kitchen and the bank read different sources. `lock-week` builds the cook list
// from D1; billing lives in Stripe. When they drift, food goes out unpaid and nobody finds out for
// weeks. It has happened three times:
//   - Jameson  (2026-07-10) paid, but the lock cron had run a day early so no order row existed.
//   - Jeferson (2026-07-23) paid, order stuck 'pending', meals made by hand off-system.
//   - Jeferson (2026-08-02) picked up 14 meals with NO payment: his 07-30 renewal invoice was VOIDED.
//   - Luis Soto (2026-08-09) 14 meals cooked with NO payment: he canceled, and the $0 invoice Stripe
//     raised when the subscription ended read as 'paid' + 'subscription_cycle', identical to a comp.
//     THIS CHECK COUNTED HIM AS PAID and reported the week clean apart from two others.
//
// ⚠️ THE LESSON FROM THAT THIRD ONE — READ BEFORE CHANGING THIS FILE. The original version of this
// check asked "does this customer look unhealthy?" (subscription past_due/unpaid, or carrying an OPEN
// invoice). Jeferson passed every one of those: his subscription was 'active' and he had no open
// invoice, because the unpaid week had been VOIDED rather than left outstanding. The check reported
// "0 mismatches" on the very morning he collected $119 of unpaid food.
//
// So it no longer infers health. It answers the only question that matters, directly:
//     for THIS delivery week, does a PAID invoice exist that covers it?
// Health signals are proxies; a payment is the fact. Never regress this to a status check.
//
// HOW A PAYMENT MAPS TO A DELIVERY: see _lib/billing_day.js deliveryBoughtBy() — a signup buys the week
// that was orderable at checkout, a renewal (which now fires Saturday, AFTER the Friday cutoff) buys the
// imminent Sunday. That single helper is shared with the anchor logic so the two can never disagree.
//
// SCALING: one Stripe invoice-list call covers the WHOLE roster (paginated, capped), not one call per
// customer — Cloudflare caps subrequests per invocation and this must still work at 200 customers.
import { ok, fail } from '../../_lib/respond.js';
import { requireStaffOrAdmin } from '../../_lib/admin.js';
import { all } from '../../_lib/db.js';
import { upcomingSunday, isLocked, cutoffForWeek } from '../../_lib/menu.js';
import { stripe } from '../../_lib/stripe.js';
import { invoiceSubscriptionId } from '../../_lib/mirror.js';
import { deliveryBoughtBy, anchorForDelivery } from '../../_lib/billing_day.js';
import { ownerNotify } from '../../_lib/owner_notify.js';

const LOOKBACK_DAYS = 45;   // far enough back to cover any prepaid week still in play
const MAX_PAGES = 5;        // 500 invoices — a hard stop so a bad filter can't spin

// Does this PAID invoice actually represent a week of food that got bought?
//
// ⚠️ status:'paid' AND billing_reason ARE BOTH INSUFFICIENT — verified against live Stripe 2026-08-08.
// Brycen's and Marissa's OWNERS100 comp renewals arrive as $0 with billing_reason 'subscription_cycle'
// and MUST keep counting. Luis Soto's subscription ended that same morning and produced a $0 invoice
// with billing_reason 'subscription_cycle' too — byte-for-byte the same on both fields — and it must
// NOT count. It did: the audit filed him inside "10 paid" and reported 2 issues on the very morning
// 14 of his meals went into the cook with nothing paying for them. Same failure shape as Jeferson,
// one field further in.
//
// What actually separates them is a DISCOUNT. A comp is real meal charges taken to zero by a 100%-off
// coupon, so the invoice carries a discount (and a subtotal that the discount zeroed). A trial-end or
// cancellation invoice has nothing billable on it at all — no discount, no subtotal.
//
// Do NOT "simplify" this into an amount test (that erases every comp and floods the alert with false
// positives until people stop reading it) or back into a billing_reason test (that is what let Luis
// through). Returns the KIND of coverage, or null when the invoice bought nothing.
function invoiceCoversDelivery(inv) {
  if ((inv.amount_paid || 0) > 0) return 'paid';
  const hasDiscount = !!inv.discount || (Array.isArray(inv.discounts) && inv.discounts.length > 0);
  const zeroedByDiscount = (inv.subtotal || 0) > 0 && (inv.total || 0) === 0;
  return (hasDiscount || zeroedByDiscount) ? 'comp' : null;
}

// Pull every PAID invoice in the window and map stripe_subscription_id → Set(delivery weeks it paid for).
// Only 'paid' counts. A voided invoice (the pause_collection behaviour, and exactly what happened to
// Jeferson) collected nothing and must never be read as coverage — and neither does a $0 invoice that
// no discount explains (see invoiceCoversDelivery above).
async function paidWeeksBySubscription(env) {
  const sinceTs = Math.floor((Date.now() - LOOKBACK_DAYS * 86400 * 1000) / 1000);
  const map = new Map();
  let startingAfter = null, pages = 0, counted = 0, ignored = 0, truncated = false;

  while (pages < MAX_PAGES) {
    const params = { status: 'paid', limit: 100, created: { gte: sinceTs } };
    if (startingAfter) params.starting_after = startingAfter;
    const page = await stripe(env, 'GET', 'invoices', params);
    const rows = page.data || [];
    for (const inv of rows) {
      const subId = invoiceSubscriptionId(inv);
      if (!subId) continue;
      const kind = invoiceCoversDelivery(inv);
      if (!kind) { ignored++; continue; }   // $0 with nothing bought — buys no delivery
      const week = deliveryBoughtBy(new Date(inv.created * 1000), inv.billing_reason);
      if (!map.has(subId)) map.set(subId, new Map());
      // Keep the invoice that covered it, so the report can cite real money. Stripe returns newest
      // first, so first-write-wins keeps the most recent evidence for a week rather than the oldest.
      const weeks = map.get(subId);
      if (!weeks.has(week)) {
        weeks.set(week, { id: inv.id, amount: (inv.amount_paid || 0) / 100, reason: inv.billing_reason, kind });
      }
      counted++;
    }
    pages++;
    if (!page.has_more || !rows.length) break;
    startingAfter = rows[rows.length - 1].id;
    if (pages === MAX_PAGES && page.has_more) truncated = true;
  }
  return { map, counted, ignored, truncated };
}

async function audit(env, weekOf) {
  // ⚠️ ONLY MEANINGFUL AFTER THE WEEK LOCKS. Before the Friday-midnight cutoff orders sit 'pending' by
  // design, so running early reports every subscriber as missing. An alert people learn to ignore is
  // worse than no alert.
  if (!isLocked(weekOf)) {
    return { week_of: weekOf, status: 'not_locked_yet', cooking_for: 0, issue_count: 0, issues: [],
      note: 'Ordering is still open for this week — mismatches cannot be judged until it locks.' };
  }

  const locked = await all(env.DB,
    `SELECT o.subscription_id, o.total_meals, o.delivery_method,
            s.status AS sub_status, s.stripe_subscription_id,
            c.id AS customer_id, c.first_name, c.last_name, c.email, c.phone
       FROM orders o
       JOIN subscriptions s ON s.id = o.subscription_id
       JOIN customers c ON c.id = o.customer_id
      WHERE o.week_of = ? AND o.status = 'locked'`, weekOf);

  // Cutoff passed but NOTHING locked → the lock cron didn't run. One loud failure, not N noisy ones.
  // This is the shape of the day-of-week cron bug that closed ordering early in July.
  if (locked.length === 0) {
    return { week_of: weekOf, status: 'lock_never_ran', cooking_for: 0, issue_count: 1,
      issues: [{ type: 'lock_never_ran', name: 'ALL CUSTOMERS', detail:
        `Ordering for ${weekOf} is past cutoff but NOT ONE order is locked — the lock cron did not run. Nobody will be cooked for. Run /api/admin/lock-week.` }] };
  }

  // ⚠️ THE PAYMENT CHECK CANNOT RUN BEFORE BILLING DOES. The lock fires Sat 07:30 UTC, the pre-shop
  // audit runs 13:00 UTC, but billing anchors fire at 15:00 UTC — so at 7am Mountain almost nobody has
  // paid for tomorrow's delivery yet and a naive run would flag the ENTIRE roster. The 17:00 UTC pass
  // is the one that judges payment; the early pass still earns its slot by catching the other
  // direction (an active subscriber the kitchen has no order for) while Jayson can still act on it.
  const billingAt = anchorForDelivery(weekOf);
  const billingSettled = Date.now() >= billingAt.getTime() + 20 * 60 * 1000; // 20 min for Stripe to settle

  const { map: paidWeeks, counted, ignored, truncated } = billingSettled
    ? await paidWeeksBySubscription(env)
    : { map: new Map(), counted: 0, ignored: 0, truncated: false };
  const issues = [];
  let paidCount = 0;

  for (const o of billingSettled ? locked : []) {
    const who = `${o.first_name || '?'} ${o.last_name || ''}`.trim();
    const cover = o.stripe_subscription_id ? paidWeeks.get(o.stripe_subscription_id)?.get(weekOf) : null;

    if (cover) {
      paidCount++;
      // INDEPENDENT TRIPWIRE, deliberately not routed through the invoice logic above. A canceled
      // subscription in the cook list is worth a human glance no matter how confident the payment
      // scan is, because the lock (Sat 01:30 MT) runs seven and a half hours before billing (09:00)
      // — so a cancellation that lands in between commits food that nothing pays for, and the only
      // thing standing between that and a loss is this report. If the payment evidence is genuine
      // (they paid, then canceled) this costs one glance; if it is not, it is the whole catch.
      if (o.sub_status === 'canceled') {
        issues.push({
          type: 'canceled_but_cooking', name: who, email: o.email, phone: o.phone,
          customer_id: o.customer_id, meals: o.total_meals, sub_status: o.sub_status,
          delivery_method: o.delivery_method,
          detail: `Cooking ${o.total_meals} meals for ${weekOf} but the subscription is CANCELED. Payment scan says covered by invoice ${cover.id} (${cover.kind}, $${cover.amount.toFixed(2)}, ${cover.reason}) — confirm that really covers this week before the food goes out.`,
        });
      }
      continue;
    }

    // THE CORE FINDING: food is going out for a delivery week no payment covers.
    issues.push({
      type: 'locked_but_not_paid', name: who, email: o.email, phone: o.phone,
      customer_id: o.customer_id, meals: o.total_meals, sub_status: o.sub_status,
      delivery_method: o.delivery_method,
      detail: `Cooked ${o.total_meals} meals for the ${weekOf} ${o.delivery_method === 'delivery' ? 'delivery' : 'pickup'}, but NO paid invoice covers that week. Subscription reads '${o.sub_status}' — check for a voided or failed renewal.`,
    });
  }

  // The other direction: an active subscriber the kitchen has no locked order for. created_at < cutoff
  // is REQUIRED — a subscription that started after this week locked is ordering for the NEXT week and
  // was never meant to be on this cook list.
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

  for (const m of missing) {
    issues.push({ type: 'paying_but_not_locked', name: `${m.first_name || '?'} ${m.last_name || ''}`.trim(),
      email: m.email, phone: m.phone, customer_id: m.customer_id, meals: m.meals_per_week,
      sub_status: m.sub_status, order_status: m.order_status || 'none',
      detail: m.order_status
        ? `Order exists but is '${m.order_status}', not locked — the kitchen will not cook it.`
        : 'Active subscriber with no order at all for this week.' });
  }

  const report = { week_of: weekOf, cooking_for: locked.length, paid_and_cooked: paidCount,
    invoices_examined: counted, zero_value_invoices_ignored: ignored,
    payment_check_ran: billingSettled, issue_count: issues.length, issues };
  // A skipped payment check must be visible. "0 issues" because we did not look is not the same as
  // "0 issues" because everything is paid, and nobody should have to guess which one they're reading.
  if (!billingSettled) {
    report.note = `Billing for ${weekOf} fires ${billingAt.toISOString()} — payment coverage not judged yet. Order-side checks still ran.`;
  }
  // Never let a silent cap masquerade as a clean report.
  if (truncated) report.warning = `Invoice scan hit the ${MAX_PAGES}-page cap — coverage may be incomplete.`;
  return report;
}

export async function onRequest(context) {
  const { request, env } = context;
  const denied = await requireStaffOrAdmin(context);
  if (denied) return denied;

  const weekOf = new URL(request.url).searchParams.get('week_of') || upcomingSunday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekOf)) return fail(400, 'bad_week', 'week_of must be YYYY-MM-DD.');

  const report = await audit(env, weekOf);

  // Alert owners only on the cron (POST) path and only when something is wrong — a human opening this
  // in the dashboard should never fire a text at everyone.
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
