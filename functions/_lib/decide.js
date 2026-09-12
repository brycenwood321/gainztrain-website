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
// THE STRUCTURAL FACT BEHIND ALL OF IT, AS IT STOOD UNTIL 2026-09-06: the lock ran Sat 07:30 UTC and
// billing ran Sat 15:00 UTC. Anything that decided the money at 15:00 was invisible to the decision
// made at 07:30, so the cook list was always committed before Stripe agreed. Four weeks leaked that way
// (Jeferson, Luis, Destiny, Stephen).
//
// SINCE 2026-09-06 ("bill at the lock"): Stripe drafts each renewal at 07:15 UTC and the lock at 08:00
// UTC CHARGES that draft before it writes the order as locked. The per-customer decision now has two
// halves: cookDecision() on the D1 row (tier, unpaid prior invoice, after-cutoff signup) and
// lockAction() on a LIVE Stripe read (paused, canceled, queued cancel, draft present, period rolled),
// then chargeOutcome() on the invoice Stripe hands back. cookDecision is still the cheap preventer,
// lockAction is the money preventer, buildAuditReport is the detector. None can do another's job.
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
  // 1. (MOVED 2026-09-06.) A queued cancellation used to be refused here: `cancel_at_period_end` fired
  //    AT the period end, Sat 15:00 UTC, after the 07:30 lock, so the sub still read 'active' when the
  //    food was committed (Luis Soto, 2026-08-09: 14 meals cooked, $0 collected). With billing at
  //    07:15 and the lock at 08:00 that rule INVERTS: a cancel queued before 07:15 has already turned
  //    the sub 'canceled' by lock time, and a cancel queued after 07:15 points at NEXT Saturday with a
  //    live draft for THIS week that Stripe will charge regardless. Skipping the second group would be
  //    "charged, not fed", the reverse of Destiny. The rule now lives in lockAction(), which reads the
  //    LIVE subscription and knows whether the period has rolled. The D1 flag alone cannot tell.
  //
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

// THE PAYMENT CHECK CANNOT RUN BEFORE BILLING DOES. Until 2026-09-06 billing anchors fired at 15:00
// UTC, so the 13:00 UTC pre-shop audit could only catch the other direction (an active subscriber the
// kitchen had no order for) and the 17:00 pass judged payment. Since the anchor moved to 07:15 UTC
// and the lock charges at 08:00, BOTH Saturday passes judge money. The guard stays: anchorForDelivery
// is the single source of the hour, so this needs no edit when the hour moves.
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

// ---- BILL AT THE LOCK (2026-09-06) ------------------------------------------------------------
// Two more pure decisions, used by api/admin/lock-week.js. Both take plain objects so a test can hand
// them a Stripe-shaped fixture with no key and no network.

// Policies Brycen owns. Read through lockPolicies(env) so a flip is an env var, not a code change.
//   declined:      what to do when the card declines AT the lock.
//                    'cook'      cook and chase (Smart Retries; rule 2 blocks them next week). DEFAULT.
//                    'withhold'  no pay, no food; row written unpaid_not_cooked so it stays visible.
//   queuedCancel:  a cancel queued between the 07:15 anchor and the 08:00 lock. The period already
//                  rolled, so Stripe will charge this week's draft at ~08:15 whether we cook or not.
//                    'cook'      charge and cook; it is their last week. DEFAULT (his rule, his words).
//                    'void'      void the draft and skip; no charge, no food.
export const LOCK_POLICY_DEFAULTS = Object.freeze({ declined: 'cook', queuedCancel: 'cook' });
export function lockPolicies(env = {}) {
  const declined = env.LOCK_DECLINED_POLICY === 'withhold' ? 'withhold' : 'cook';
  const queuedCancel = env.LOCK_QUEUED_CANCEL_POLICY === 'void' ? 'void' : 'cook';
  return { declined, queuedCancel };
}

// The period end Stripe reports for a live subscription. current_period_end moved onto subscription
// ITEMS (memory stripe-flat-fields-relocate); read the item first, fall back to the flat field.
export function livePeriodEndMs(live) {
  const end = live?.items?.data?.[0]?.current_period_end || live?.current_period_end;
  return end ? end * 1000 : null;
}

// What the lock should do with ONE customer, given the LIVE subscription and this cycle's draft.
//
//   live     the Stripe subscription object (never the D1 mirror: rebill-anchor.js documents the
//            mirror lying about pauses, and this decision now commits money, not just food)
//   draft    this cycle's draft invoice or null (the caller picks the one whose period starts on or
//            after this Saturday)
//   weekOf   delivery Sunday, YYYY-MM-DD
//   now      Date, injectable for tests
//   policies from lockPolicies(env)
//
// Returns { action, reason, message? }:
//   skip      paused or canceled BEFORE the lock. Stripe voids or never creates the draft on its own.
//   charge    the period rolled at 07:15 and the draft is here: attach the upcharge, finalize, pay.
//   retry     the period rolled but Stripe has not created the draft yet (lag). Do not lock, do not
//             notify; pass 2 at 08:30 comes back. This is NOT the same fact as "paused", which is why
//             the live read comes first.
//   legacy    the anchor never moved (migration missed this sub, or a resume landed on the old hour):
//             cook on the old path (pending upcharge, Stripe bills later) and flag it by name.
//   void      queuedCancel policy is 'void': void the draft and skip.
//   settled   no draft, but Stripe has ALREADY finalized this cycle's invoice (`settled`): it auto-advanced
//             before the lock ran. Charge nothing; chargeOutcome(settled) says what happened and the
//             order is locked or withheld from that. Added 2026-09-12, the morning this exact thing
//             happened to every customer.
export function lockAction({ live, draft, settled = null, weekOf, now = new Date(), policies = LOCK_POLICY_DEFAULTS }) {
  if (!live) return { action: 'retry', reason: 'no_live_read', message: 'live subscription read failed, will retry' };
  const st = live.status;
  if (st === 'canceled' || st === 'incomplete_expired') {
    return { action: 'skip', reason: 'canceled_before_lock', message: `canceled before the lock (status ${st}), not cooked` };
  }
  if (live.pause_collection) {
    return { action: 'skip', reason: 'paused_before_lock', message: 'paused before the lock (pause_collection set), not cooked; Stripe voids the draft itself' };
  }
  if (!COOKABLE.includes(st)) {
    return { action: 'skip', reason: `status_${st}`, message: `status ${st} is not cookable, not cooked` };
  }

  // Has the period rolled past this delivery's anchor? The anchor for weekOf is the Saturday before it
  // at ANCHOR_HOUR:ANCHOR_MINUTE. A rolled sub's period end is a WEEK later than that. A legacy sub
  // (anchor never moved) still shows a period end on the anchor's own day, e.g. 15:00 that Saturday,
  // which is after the anchor but not by a day. So the line is drawn at anchor + 24h.
  const anchorMs = anchorForDelivery(weekOf).getTime();
  const endMs = livePeriodEndMs(live);
  const rolled = endMs != null && endMs > anchorMs + 24 * 3600 * 1000;
  if (!rolled) {
    return { action: 'legacy', reason: 'anchor_not_moved',
      message: `period end ${endMs ? new Date(endMs).toISOString() : 'unknown'} has not rolled past the ${new Date(anchorMs).toISOString()} anchor: cooked on the LEGACY path (billed later), check this subscription's anchor` };
  }

  // Already finalized by Stripe: the money question is answered, read it. Checked BEFORE the queued-cancel
  // fork because a paid invoice cannot be voided and a void one is already what the policy wanted.
  if (!draft && settled) {
    const how = settled.billing_reason === 'subscription_create' ? 'paid at checkout for this week (first week)' : 'Stripe finalized before the lock ran';
    return { action: 'settled', reason: settled.billing_reason === 'subscription_create' ? 'paid_at_checkout' : 'stripe_charged_before_lock',
      message: `${settled.id} (${settled.status}): ${how}${live.cancel_at_period_end ? ', cancel queued: this is their last week' : ''}` };
  }

  if (live.cancel_at_period_end) {
    if (policies.queuedCancel === 'void') {
      return { action: 'void', reason: 'queued_cancel_void_policy', message: 'cancel queued after the anchor; policy is void: draft voided, not cooked' };
    }
    if (!draft) return { action: 'retry', reason: 'no_draft_yet', message: 'period rolled but no draft yet (Stripe lag), will retry' };
    return { action: 'charge', reason: 'queued_cancel_last_week', message: 'cancel queued after the anchor: charged and cooked, this is their last week' };
  }

  if (!draft) return { action: 'retry', reason: 'no_draft_yet', message: 'period rolled but no draft yet (Stripe lag), will retry' };
  return { action: 'charge', reason: 'draft_ready' };
}

// Pick this cycle's draft out of a list of the subscription's draft invoices. THE SIGNAL IS `created`:
// Stripe creates the renewal draft AT the anchor (Sat 07:15Z), so this cycle's draft was created on or
// after Saturday 00:00 UTC and a stale one from a previous cycle was not.
//
// ⚠️ NOT `period_start`. On a subscription_cycle invoice Stripe's invoice-level period_start is the start
// of the period being CLOSED, i.e. the PREVIOUS cycle (the D1 mirror of 2026-09-12's drafts shows
// period_start 2026-09-05 and 2026-09-07 on invoices created 2026-09-12T07:15Z). Until 2026-09-12 this
// filtered on period_start first, so no real draft ever qualified, every customer read "no draft yet"
// and the lock could never charge anyone. The test fixture had supplied its own period_start on the
// anchor day, which is why the test passed (memory: tests-that-supply-their-own-answer).
function cycleDayStart(weekOf) {
  const anchor = anchorForDelivery(weekOf);
  return Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate()) / 1000;
}
function inThisCycle(inv, dayStart) {
  return (inv.created || 0) >= dayStart || (inv.period_start || 0) >= dayStart;
}
export function pickCycleDraft(drafts, weekOf) {
  if (!Array.isArray(drafts) || drafts.length === 0) return null;
  const dayStart = cycleDayStart(weekOf);
  const ok = drafts.filter((d) => d && d.status === 'draft' && inThisCycle(d, dayStart));
  ok.sort((a, b) => (b.created || 0) - (a.created || 0));
  return ok[0] || null;
}

// This cycle's invoice when Stripe has ALREADY finalized it (paid, open, uncollectible or void). Stripe
// auto-advances a draft about an hour after creating it, so if the lock runs late (2026-09-12: the cron
// scheduler kept firing the retired 07:30 slot and never the 08:00 one, and Stripe charged 22 customers
// at 08:15 on its own) there is no draft left to charge. The money already moved; the lock's job is
// then to READ the outcome and lock the food, never to charge again. Same `created` rule as the draft.
//
// FIRST-WEEK CUSTOMERS (2026-09-12, second gap the same morning): a signup pays at CHECKOUT for the week
// that was orderable at that moment and is anchored to the FOLLOWING Saturday, so on their first lock
// there is no renewal draft and no cycle invoice, only the checkout invoice from days earlier. Without
// this clause they read "retry" forever and never lock (Maren, Dean, Paul: 25 meals paid, none locked).
// The checkout invoice counts when deliveryBoughtBy() says it bought THIS delivery Sunday.
export function pickCycleInvoice(invoices, weekOf) {
  if (!Array.isArray(invoices) || invoices.length === 0) return null;
  const dayStart = cycleDayStart(weekOf);
  const boughtThisWeek = (i) => i.billing_reason === 'subscription_create' && i.created
    && deliveryBoughtBy(new Date(i.created * 1000), 'subscription_create') === weekOf;
  const ok = invoices.filter((i) => i && i.status && i.status !== 'draft' && i.status !== 'deleted'
    && (inThisCycle(i, dayStart) || boughtThisWeek(i)));
  // The RENEWAL first (a same-day tier change also raises a small proration invoice), then newest.
  const cyc = (i) => (i.billing_reason === 'subscription_cycle' ? 1 : 0);
  ok.sort((a, b) => (cyc(b) - cyc(a)) || ((b.created || 0) - (a.created || 0)));
  return ok[0] || null;
}

// What Stripe says happened to the invoice the lock tried to charge. Read AFTER the pay call, from a
// fresh GET, because functions/_lib/stripe.js throws on any non-2xx: a declined card arrives as an
// exception, not as a status in the response, so the exception is caught and the invoice re-read.
//   paid      money moved
//   comp      $0 with a discount: a real comp week (same discriminator as invoiceCoversDelivery)
//   declined  open or uncollectible after a pay attempt
//   void      voided (a pause raced us to finalization)
//   draft     still a draft (finalize failed); treat as retry
//   unknown   anything else; treat as retry
export function chargeOutcome(inv) {
  if (!inv) return 'unknown';
  if (inv.status === 'paid') return (inv.amount_paid || 0) > 0 ? 'paid' : (invoiceCoversDelivery(inv) === 'comp' ? 'comp' : 'paid');
  if (inv.status === 'open' || inv.status === 'uncollectible') return 'declined';
  if (inv.status === 'void') return 'void';
  if (inv.status === 'draft') return 'draft';
  return 'unknown';
}

// Given the charge outcome and the declined policy: does this customer get cooked, and what does the
// order row say? Returns { cook, charge_status, order_status }.
export function feedAfterCharge(outcome, policies = LOCK_POLICY_DEFAULTS) {
  if (outcome === 'paid' || outcome === 'comp') return { cook: true, charge_status: outcome, order_status: 'locked' };
  if (outcome === 'declined') {
    return policies.declined === 'withhold'
      ? { cook: false, charge_status: 'declined', order_status: 'unpaid_not_cooked' }
      : { cook: true, charge_status: 'declined', order_status: 'locked' };
  }
  if (outcome === 'void') return { cook: false, charge_status: null, order_status: null };   // skip, report
  return { cook: false, charge_status: null, order_status: null };                            // retry
}
