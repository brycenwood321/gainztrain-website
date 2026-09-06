// THE TWO DECISIONS THAT MOVE MONEY AND FOOD, extracted as pure functions so they can be tested
// without a D1 binding, a Stripe key, or a Cloudflare runtime.
//
//   WHO GETS FED  -> cookDecision()          (used by api/admin/lock-week.js, Sat 07:30 UTC)
//   WHO GOT PAID  -> invoiceCoversDelivery(), paidWeeksFromInvoices(), buildAuditReport()
//                                            (used by api/admin/payment-order-audit.js, Sat 13:00 + 17:00 UTC)
//
// This file holds NO new logic. Every branch below was lifted from those two endpoints, which now
// import from here, so there is exactly one definition of each rule and a test can reach it. The
// endpoints keep all the I/O: SQL, Stripe pagination, owner alerts.
//
// The only edit made during the extraction: the owner-facing `detail` sentences lost their em dash
// characters (Brycen's first hard rule, and a guard hook blocks the write). Wording, issue `type`
// values and every branch are otherwise unchanged, and nothing in the codebase parses those
// sentences: they are read by humans in an owner alert.
//
// THE STRUCTURAL FACT BEHIND ALL OF IT: the lock runs Sat 07:30 UTC and billing runs Sat 15:00 UTC.
// Anything that decides the money at 15:00 is invisible to the decision made at 07:30, so the cook
// list is always committed before Stripe agrees. cookDecision is the PREVENTER, buildAuditReport is
// the DETECTOR, and neither can do the other's job.
//
// Tests: test/charge_and_feed.test.mjs (npm test). Every case in there is a week that actually went
// wrong in production. Add a fixture before changing a rule here.
import { MIN_MEALS } from './plans.js';
import { anchorForDelivery, deliveryBoughtBy } from './billing_day.js';
import { invoiceSubscriptionId } from './mirror.js';

// Subscription statuses whose owners get meals cooked. 'paused' is deliberately EXCLUDED: a paused
// customer is not billed and gets no meals. 'past_due' IS included on purpose so one declined card
// does not cost somebody their week; the open-invoice rule below is what bounds that.
export const COOKABLE = ['active', 'trialing', 'past_due'];

// ---- WHO GETS FED --------------------------------------------------------------------------
// `status` alone is NOT enough to decide who eats, and every rule below cost real money first.
// Returns { cook: true } or { cook: false, reason, message }. The caller pushes `message` onto
// summary.errors, which already emails the owners. A skip must always REPORT: a customer wrongly
// withheld from a cook has to be visible the same morning, or the guard becomes its own silent
// failure.
//
// `cutoff` is the ordering cutoff for the week being locked, as an ISO-8601 STRING.
export function cookDecision(sub, cutoff) {
  // 0. Legacy or misconfigured sub with no real tier yet. Surface it instead of locking an empty
  //    order; these need enrich-ghl to set meals_per_week first.
  if (!(sub.meals_per_week >= MIN_MEALS)) {
    return { cook: false, reason: 'needs_enrichment',
      message: `sub ${sub.id}: meals_per_week=${sub.meals_per_week} (< ${MIN_MEALS}), needs enrichment, not locked` };
  }
  // 1. A queued cancellation. `cancel_at_period_end` fires AT the period end (Sat 15:00 UTC), so the
  //    sub still reads 'active' at 07:30 UTC when the food is committed. Luis Soto, delivery week
  //    2026-08-09: 14 meals cooked, $0 collected. Already mirrored into D1, so this costs no extra
  //    Stripe call.
  if (sub.cancel_at_period_end) {
    return { cook: false, reason: 'pending_cancellation',
      message: `sub ${sub.id} (${sub.email}): cancellation queued for the period end, NOT cooked (would have been an unpaid week)` };
  }
  // 2. An unpaid prior invoice. Stripe's Smart Retries hold 'past_due' for about 3 weeks, so with no
  //    bound a dead card buys free food every Saturday, compounding. One open invoice is the bound.
  if (sub.open_invoices > 0) {
    return { cook: false, reason: 'unpaid_invoice',
      message: `sub ${sub.id} (${sub.email}): ${sub.open_invoices} unpaid invoice(s), NOT cooked until the card is fixed` };
  }
  // 3. A signup that landed after this week's cutoff. They paid for the FOLLOWING Sunday and
  //    anchored to the next Saturday; sweeping them in here hands them a free auto-filled week.
  //
  //    COMPARE STRING TO STRING. `sub.created_at` is an ISO-8601 string out of D1. If `cutoff` is a
  //    Date object, `string >= Date` coerces both operands to numbers, the ISO string becomes NaN,
  //    and the comparison is false for EVERY customer, so the guard silently never fires. That is
  //    what shipped in lock-week.js from 2026-08-12 until this extraction. See the test named
  //    "post-cutoff guard is dead when handed a Date" in test/charge_and_feed.test.mjs.
  if (cutoff && sub.created_at && sub.created_at >= cutoff) {
    return { cook: false, reason: 'after_cutoff',
      message: `sub ${sub.id} (${sub.email}): created ${sub.created_at}, after the ${cutoff} cutoff, starts next week, NOT cooked` };
  }
  return { cook: true };
}

// ---- WHO GOT PAID --------------------------------------------------------------------------
// Does this PAID invoice actually represent a week of food that got bought?
//
// status:'paid' AND billing_reason ARE BOTH INSUFFICIENT, verified against live Stripe 2026-08-08.
// Brycen's and Marissa's OWNERS100 comp renewals arrive as $0 with billing_reason
// 'subscription_cycle' and MUST keep counting. Luis Soto's subscription ended that same morning and
// produced a $0 invoice with billing_reason 'subscription_cycle' too, byte for byte the same on both
// fields, and it must NOT count. It did: the audit filed him inside "10 paid" and reported 2 issues
// on the very morning 14 of his meals went into the cook with nothing paying for them. Same failure
// shape as Jeferson, one field further in.
//
// What actually separates them is a DISCOUNT. A comp is real meal charges taken to zero by a
// 100%-off coupon, so the invoice carries a discount, and a subtotal that the discount zeroed. A
// trial-end or cancellation invoice has nothing billable on it at all: no discount, no subtotal.
//
// Do NOT "simplify" this into an amount test (that erases every comp and floods the alert with false
// positives until people stop reading it) or back into a billing_reason test (that is what let Luis
// through). Returns the KIND of coverage, or null when the invoice bought nothing.
export function invoiceCoversDelivery(inv) {
  if ((inv.amount_paid || 0) > 0) return 'paid';
  const hasDiscount = !!inv.discount || (Array.isArray(inv.discounts) && inv.discounts.length > 0);
  const zeroedByDiscount = (inv.subtotal || 0) > 0 && (inv.total || 0) === 0;
  return (hasDiscount || zeroedByDiscount) ? 'comp' : null;
}

// Map a flattened list of PAID Stripe invoices to stripe_subscription_id -> Map(delivery week ->
// evidence). Only 'paid' invoices should reach here. A voided invoice (the pause_collection
// behaviour, and exactly what happened to Jeferson) collected nothing and must never be read as
// coverage, and neither does a $0 invoice that no discount explains.
//
// Stripe returns newest first, so first-write-wins keeps the most recent evidence for a week rather
// than the oldest. Callers MUST preserve that ordering.
export function paidWeeksFromInvoices(invoices) {
  const map = new Map();
  let counted = 0, ignored = 0;
  for (const inv of invoices) {
    const subId = invoiceSubscriptionId(inv);
    if (!subId) continue;
    const kind = invoiceCoversDelivery(inv);
    if (!kind) { ignored++; continue; }   // $0 with nothing bought, buys no delivery
    const week = deliveryBoughtBy(new Date(inv.created * 1000), inv.billing_reason);
    if (!map.has(subId)) map.set(subId, new Map());
    const weeks = map.get(subId);
    if (!weeks.has(week)) {
      weeks.set(week, { id: inv.id, amount: (inv.amount_paid || 0) / 100, reason: inv.billing_reason, kind });
    }
    counted++;
  }
  return { map, counted, ignored };
}

// THE PAYMENT CHECK CANNOT RUN BEFORE BILLING DOES. The lock fires Sat 07:30 UTC, the pre-shop audit
// runs 13:00 UTC, but billing anchors fire at 15:00 UTC, so at 7am Mountain almost nobody has paid
// for tomorrow's delivery yet and a naive run would flag the ENTIRE roster. The 17:00 UTC pass is the
// one that judges payment; the early pass still earns its slot by catching the other direction (an
// active subscriber the kitchen has no order for) while Jayson can still act on it.
const SETTLE_MS = 20 * 60 * 1000; // 20 min for Stripe to settle after the anchor fires

export function paymentCheckReady(weekOf, now = new Date()) {
  return now.getTime() >= anchorForDelivery(weekOf).getTime() + SETTLE_MS;
}

export function emptyScan() {
  return { map: new Map(), counted: 0, ignored: 0, truncated: false };
}

// Ordering is still open, so mismatches cannot be judged. An alert people learn to ignore is worse
// than no alert.
export function notLockedReport(weekOf) {
  return { week_of: weekOf, status: 'not_locked_yet', cooking_for: 0, issue_count: 0, issues: [],
    note: 'Ordering is still open for this week, so mismatches cannot be judged until it locks.' };
}

// Cutoff passed but NOTHING locked means the lock cron did not run. One loud failure, not N noisy
// ones. This is the shape of the day-of-week cron bug that closed ordering early in July.
export function lockNeverRanReport(weekOf) {
  return { week_of: weekOf, status: 'lock_never_ran', cooking_for: 0, issue_count: 1,
    issues: [{ type: 'lock_never_ran', name: 'ALL CUSTOMERS', detail:
      `Ordering for ${weekOf} is past cutoff but NOT ONE order is locked, so the lock cron did not run. Nobody will be cooked for. Run /api/admin/lock-week.` }] };
}

// The reconciliation itself, over rows the caller already fetched.
//
//   weekOf          delivery Sunday, YYYY-MM-DD
//   locked          rows from the locked-orders query (order joined to subscription and customer)
//   missing         rows from the active-subscriber-with-no-locked-order query
//   scan            { map, counted, ignored, truncated } from paidWeeksFromInvoices, or emptyScan()
//   billingSettled  whether the payment half was allowed to run at all
//   maxPages        page cap the caller used, for the truncation warning text
export function buildAuditReport({ weekOf, locked, missing, scan, billingSettled, maxPages }) {
  const { map: paidWeeks, counted, ignored, truncated } = scan;
  const issues = [];
  let paidCount = 0;

  for (const o of billingSettled ? locked : []) {
    const who = `${o.first_name || '?'} ${o.last_name || ''}`.trim();
    const cover = o.stripe_subscription_id ? paidWeeks.get(o.stripe_subscription_id)?.get(weekOf) : null;

    if (cover) {
      paidCount++;
      // INDEPENDENT TRIPWIRE, deliberately not routed through the invoice logic above. A canceled
      // subscription in the cook list is worth a human glance no matter how confident the payment
      // scan is, because the lock (Sat 01:30 MT) runs seven and a half hours before billing (09:00),
      // so a cancellation that lands in between commits food that nothing pays for, and the only
      // thing standing between that and a loss is this report. If the payment evidence is genuine
      // (they paid, then canceled) this costs one glance; if it is not, it is the whole catch.
      if (o.sub_status === 'canceled') {
        issues.push({
          type: 'canceled_but_cooking', name: who, email: o.email, phone: o.phone,
          customer_id: o.customer_id, meals: o.total_meals, sub_status: o.sub_status,
          delivery_method: o.delivery_method,
          detail: `Cooking ${o.total_meals} meals for ${weekOf} but the subscription is CANCELED. Payment scan says covered by invoice ${cover.id} (${cover.kind}, $${cover.amount.toFixed(2)}, ${cover.reason}). Confirm that really covers this week before the food goes out.`,
        });
      }
      continue;
    }

    // THE CORE FINDING: food is going out for a delivery week no payment covers.
    issues.push({
      type: 'locked_but_not_paid', name: who, email: o.email, phone: o.phone,
      customer_id: o.customer_id, meals: o.total_meals, sub_status: o.sub_status,
      delivery_method: o.delivery_method,
      detail: `Cooked ${o.total_meals} meals for the ${weekOf} ${o.delivery_method === 'delivery' ? 'delivery' : 'pickup'}, but NO paid invoice covers that week. Subscription reads '${o.sub_status}', check for a voided or failed renewal.`,
    });
  }

  // The other direction: an active subscriber the kitchen has no locked order for.
  for (const m of missing) {
    issues.push({ type: 'paying_but_not_locked', name: `${m.first_name || '?'} ${m.last_name || ''}`.trim(),
      email: m.email, phone: m.phone, customer_id: m.customer_id, meals: m.meals_per_week,
      sub_status: m.sub_status, order_status: m.order_status || 'none',
      detail: m.order_status
        ? `Order exists but is '${m.order_status}', not locked, so the kitchen will not cook it.`
        : 'Active subscriber with no order at all for this week.' });
  }

  const report = { week_of: weekOf, cooking_for: locked.length, paid_and_cooked: paidCount,
    invoices_examined: counted, zero_value_invoices_ignored: ignored,
    payment_check_ran: billingSettled, issue_count: issues.length, issues };
  // A skipped payment check must be visible. "0 issues" because we did not look is not the same as
  // "0 issues" because everything is paid, and nobody should have to guess which one they are
  // reading.
  if (!billingSettled) {
    report.note = `Billing for ${weekOf} fires ${anchorForDelivery(weekOf).toISOString()}, so payment coverage is not judged yet. Order-side checks still ran.`;
  }
  // Never let a silent cap masquerade as a clean report.
  if (truncated) report.warning = `Invoice scan hit the ${maxPages}-page cap, so coverage may be incomplete.`;
  return report;
}
