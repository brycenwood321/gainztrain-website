// ONE definition of the Gainz Train billing day. Every path that can create or revive a subscription
// (checkout webhook, resume, the bulk migration endpoint) re-anchors through here so they can't drift.
//
// THE RULE: a customer is charged on the SATURDAY immediately before a delivery they have not paid for.
// Lock is Friday midnight MT, the lock cron runs Sat 07:30 UTC, we bill Sat 15:00 UTC (9am MDT / 8am MST),
// and the food arrives Sunday. So money always lands after the order is final and before it's cooked —
// which is what makes "only cook a paid week" enforceable.
//
// WHY trial_end AND NOT billing_cycle_anchor: Stripe re-anchors a subscription to its trial_end, and
// billing_cycle_anchor='now' bills immediately (docs: "Stripe immediately attempts payment when a
// subscription's billing cycle anchor is reset"). trial_end + proration_behavior 'none' moves the date
// without charging. Side effect: the sub sits in status 'trialing' until that date — every live status
// gate already includes 'trialing', and both customer surfaces map it to "active" for display.
import { stripe } from './stripe.js';
import { orderableWeek, upcomingSunday } from './menu.js';

export const ANCHOR_HOUR_UTC = 15;
const MIN_LEAD_MS = 5 * 60 * 1000;        // never anchor into the past / the next few minutes
const MAX_LEAD_MS = 21 * 86400 * 1000;    // a wild anchor means bad input — refuse, don't guess

function iso(d) { return d.toISOString().slice(0, 10); }

function addDaysISO(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
}

// The Saturday immediately before a delivery Sunday, at ANCHOR_HOUR_UTC.
export function anchorForDelivery(deliverySundayISO) {
  const sunday = new Date(`${deliverySundayISO}T00:00:00Z`);
  const sat = new Date(sunday);
  sat.setUTCDate(sat.getUTCDate() - 1);
  return new Date(Date.UTC(sat.getUTCFullYear(), sat.getUTCMonth(), sat.getUTCDate(), ANCHOR_HOUR_UTC, 0, 0));
}

// Which delivery did a given payment buy? This differs by WHY the invoice was raised, and getting it
// wrong by one week either double-charges someone or hands them free food.
//
//   subscription_create (a SIGNUP) — they paid at checkout and picked meals for whatever week was
//   orderable at that moment. So: orderableWeek(paidAt).
//
//   subscription_cycle (a RENEWAL) — ⚠️ renewals now fire SATURDAY 15:00 UTC, which is AFTER the
//   Friday-midnight cutoff. orderableWeek() therefore reports the NEXT week, not the one the charge
//   actually pays for: a Saturday charge buys tomorrow's Sunday delivery. Moving billing past the
//   cutoff is exactly what broke this assumption — the derivation was written when charges landed
//   mid-week, before cutoff. Caught 2026-08-02 when the dry run wanted to push Luis, Zac, Jameson and
//   Alyssa a week late, which would have given all four the Aug 9 delivery for free.
export function deliveryBoughtBy(paidAt, billingReason) {
  return billingReason === 'subscription_cycle' ? upcomingSunday(paidAt) : orderableWeek(paidAt);
}

// The anchor after a paid invoice: the Saturday before the FOLLOWING delivery.
export function anchorAfterPaidCycle(paidAt, billingReason) {
  return anchorForDelivery(addDaysISO(deliveryBoughtBy(paidAt, billingReason), 7));
}

// ON RESUME: they've paid for nothing upcoming, so they owe the very next week they can order for.
export function anchorForNextDelivery(now = new Date()) {
  return anchorForDelivery(orderableWeek(now));
}

// Move a subscription onto its correct Saturday. Safe to call repeatedly — returns {applied:false} with
// a reason rather than throwing, so callers on the webhook/resume path can never break on it.
export async function moveToBillingDay(env, stripeSubId, anchor) {
  if (!stripeSubId || !anchor) return { applied: false, reason: 'missing_input' };
  const lead = anchor.getTime() - Date.now();
  if (lead <= MIN_LEAD_MS) return { applied: false, reason: 'anchor_in_past' };
  if (lead > MAX_LEAD_MS) return { applied: false, reason: 'anchor_too_far_out' };

  const live = await stripe(env, 'GET', `subscriptions/${stripeSubId}`);
  if (live.status === 'canceled' || live.status === 'incomplete_expired') {
    return { applied: false, reason: `status_${live.status}` };
  }
  // A paused sub bills nothing, so its anchor is meaningless until it resumes — and resume.js sets the
  // anchor itself. Combining trial_end with pause_collection is also undocumented; don't risk it.
  if (live.pause_collection) return { applied: false, reason: 'paused' };
  // ⚠️ A QUEUED CANCELLATION CANCELS *AT* THE PERIOD END — so moving that date moves the CANCELLATION,
  // not just the billing day. Luis Soto, 2026-08-08: resume re-anchored him to Sat 15:00 with
  // cancel_at_period_end still set, which scheduled his cancellation for exactly the moment he should
  // have been charged. Stripe canceled instead of billing, hours after the lock had already committed
  // 14 meals to the cook. Callers that legitimately want to keep someone must clear the flag FIRST
  // (resume.js does); everything else has no business rewriting a customer's cancellation date.
  if (live.cancel_at_period_end) return { applied: false, reason: 'pending_cancellation' };

  const itemEnd = live.items?.data?.[0]?.current_period_end || live.current_period_end;
  if (itemEnd) {
    const endMs = itemEnd * 1000;
    if (Math.abs(anchor.getTime() - endMs) < 60 * 1000) return { applied: false, reason: 'already_correct' };
    // Moving the date EARLIER would bill sooner than the customer was told. Every legitimate case moves
    // later or stays put; anything else is a data problem a human should look at.
    if (anchor.getTime() < endMs) return { applied: false, reason: 'would_bill_earlier' };
  }

  const updated = await stripe(env, 'POST', `subscriptions/${stripeSubId}`, {
    trial_end: Math.floor(anchor.getTime() / 1000),
    proration_behavior: 'none',
  }, `gt_billday_${stripeSubId}_${iso(anchor)}`);

  return { applied: true, anchor: anchor.toISOString(), previous_end: itemEnd ? new Date(itemEnd * 1000).toISOString() : null, updated };
}
