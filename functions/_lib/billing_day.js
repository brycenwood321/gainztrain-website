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
import { orderableWeek } from './menu.js';

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

// AFTER A PAID CYCLE (new signup's first invoice, or the bulk migration): that payment bought the week
// that was orderable when it was made, so the next charge covers the week after it.
export function anchorAfterPaidCycle(paidAt) {
  return anchorForDelivery(addDaysISO(orderableWeek(paidAt), 7));
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
