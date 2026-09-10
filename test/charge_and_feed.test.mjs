// WHO GETS CHARGED, AND WHO GETS FED. Run: npm test
//
// These are the two decisions that can lose real money in a single Saturday, and until this file
// existed neither had a test. The rules live in functions/_lib/decide.js; the endpoints that use
// them (api/admin/lock-week.js and api/admin/payment-order-audit.js) are I/O only.
//
// EVERY FIXTURE BELOW IS A WEEK THAT ACTUALLY WENT WRONG. Four separate weeks were reported CLEAN
// by a check that was looking at the wrong thing, and each one is reconstructed here as a test that
// fails if the code regresses to what it used to do:
//
//   FALSE-CLEAN 1  delivery 2026-07-12  Jameson   paid, no order row (lock cron ran a day early)
//   FALSE-CLEAN 2  delivery 2026-07-26  Jeferson  paid $119 on 07-23, order stuck 'pending'
//   FALSE-CLEAN 3  delivery 2026-08-02  Jeferson  14 meals eaten, 07-30 renewal VOIDED, sub still 'active'
//   FALSE-CLEAN 4  delivery 2026-08-09  Luis Soto 14 meals cooked, $0 cancellation invoice read as 'paid'
//
// Sources: functions/api/admin/payment-order-audit.js header, _data/gt/money_vs_food_audit_2026-08-08.md,
// _data/gt/health_2026-07-11.json (verdict PASS on the Jameson week), _data/session_archives/2026-07.md
// and 2026-08.md, memory gt-status-alone-cannot-decide-who-eats.
//
// The two sides of every check are kept apart on purpose (memory: two-sides-of-a-check-same-source).
// Expected weeks, statuses and issue types are written out by hand from those records, never
// recomputed through the same helper the code under test calls.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  COOKABLE, cookDecision, invoiceCoversDelivery, paidWeeksFromInvoices,
  paymentCheckReady, emptyScan, notLockedReport, lockNeverRanReport, buildAuditReport,
  lockAction, lockPolicies, LOCK_POLICY_DEFAULTS, pickCycleDraft, chargeOutcome, feedAfterCharge, livePeriodEndMs,
} from '../functions/_lib/decide.js';
import { anchorForDelivery, deliveryBoughtBy, anchorOnSameDay, ANCHOR_HOUR_UTC, ANCHOR_MINUTE_UTC } from '../functions/_lib/billing_day.js';
import { cutoffForWeek } from '../functions/_lib/menu.js';

// ---- fixture builders ------------------------------------------------------------------------

// A subscription row as lock-week.js selects it (D1 columns, ISO-8601 strings, 0/1 integers).
function sub(over = {}) {
  return {
    id: 'sub_test', email: 'test@example.com', first_name: 'Test',
    meals_per_week: 10, cancel_at_period_end: 0, open_invoices: 0,
    created_at: '2026-07-01T12:00:00.000Z',
    ...over,
  };
}

// A locked order row as payment-order-audit.js selects it (order + subscription + customer).
function lockedOrder(over = {}) {
  return {
    subscription_id: 'sub_test', total_meals: 10, delivery_method: 'pickup',
    sub_status: 'active', stripe_subscription_id: 'sub_stripe_test',
    customer_id: 'cus_d1_test', first_name: 'Test', last_name: 'Customer',
    email: 'test@example.com', phone: '+15550000000',
    ...over,
  };
}

// An active subscriber the kitchen has no locked order for.
function missingRow(over = {}) {
  return {
    sub_status: 'active', meals_per_week: 10, customer_id: 'cus_d1_test',
    first_name: 'Test', last_name: 'Customer', email: 'test@example.com',
    phone: '+15550000000', order_status: null,
    ...over,
  };
}

// A real weekly charge that went through.
function paidInvoice(over = {}) {
  return {
    id: 'in_paid', subscription: 'sub_stripe_test', status: 'paid',
    amount_paid: 10500, subtotal: 10500, total: 10500,
    billing_reason: 'subscription_cycle',
    created: Math.floor(Date.parse('2026-08-08T15:00:05Z') / 1000),
    ...over,
  };
}

// A 100%-off OWNERS100 comp renewal: real meal charges taken to zero by a coupon. $0, and it MUST
// still count as a bought week.
function compInvoice(over = {}) {
  return paidInvoice({
    id: 'in_comp', amount_paid: 0, subtotal: 6300, total: 0,
    discount: { coupon: { id: 'OWNERS100', percent_off: 100 } },
    ...over,
  });
}

// The invoice Stripe raises when a subscription ENDS. Identical to the comp above on `status` and
// `billing_reason`, and it bought nothing at all.
function cancellationInvoice(over = {}) {
  return paidInvoice({
    id: 'in_cancel', amount_paid: 0, subtotal: 0, total: 0,
    ...over,
  });
}

function scanOf(invoices) {
  return { ...paidWeeksFromInvoices(invoices), truncated: false };
}

// Every audit run in this file happens well after billing has settled, unless a test says otherwise.
function report({ weekOf, locked = [], missing = [], invoices = [], billingSettled = true, truncated = false }) {
  const scan = billingSettled ? { ...paidWeeksFromInvoices(invoices), truncated } : emptyScan();
  return buildAuditReport({ weekOf, locked, missing, scan, billingSettled, maxPages: 5 });
}

const typesIn = (r) => r.issues.map((i) => i.type);
const issueFor = (r, name) => r.issues.find((i) => i.name === name);

// ================================================================================================
// A. WHO GETS FED. The cook-list guard, lock-week.js, Saturday 07:30 UTC.
// ================================================================================================
describe('who gets fed: the cook-list guard', () => {
  const cutoff = cutoffForWeek('2026-08-09').toISOString(); // 2026-08-08T06:00:00.000Z

  test('(a) active subscription, nothing outstanding: fed', () => {
    const d = cookDecision(sub(), cutoff);
    assert.equal(d.cook, true);
  });

  test('the three cookable statuses are exactly active, trialing and past_due', () => {
    // past_due is cookable ON PURPOSE so one declined card does not cost somebody their week.
    // 'paused' must never appear: a paused customer is not billed and gets no meals.
    assert.deepEqual(COOKABLE, ['active', 'trialing', 'past_due']);
    assert.equal(COOKABLE.includes('paused'), false);
    assert.equal(COOKABLE.includes('canceled'), false);
  });

  test('(b) a queued cancellation is NO LONGER decided from the mirrored flag (moved 2026-09-06)', () => {
    // FALSE-CLEAN 4 used to be prevented here: Luis Soto queued a cancel on Thu 2026-08-07, it fired
    // AT the period end (Sat 15:00 UTC, after the 07:30 lock), 14 meals cooked, $0 collected. Since
    // billing moved to 07:15 and the lock to 08:00, the D1 flag alone cannot tell the two cases apart:
    // a cancel queued BEFORE 07:15 has already turned the sub 'canceled' by lock time, and a cancel
    // queued AFTER 07:15 has a live draft Stripe will charge regardless (skipping that one would be
    // "charged, not fed", the reverse of Destiny). So cookDecision passes the flag through and
    // lockAction() decides on the LIVE subscription. Section E replays Luis against lockAction.
    const d = cookDecision(sub({ id: 'sub_luis', email: 'luisgal.soto22@gmail.com', cancel_at_period_end: 1 }), cutoff);
    assert.equal(d.cook, true, 'the mirrored flag alone no longer withholds; the live read does');
  });

  test('(c) an open unpaid invoice: NOT fed, and reported', () => {
    // Zac Christensen, delivery 2026-08-09: renewal invoice OPEN, card declined, 6 meals went out
    // anyway. Stripe holds past_due for about 3 weeks under Smart Retries, so with no bound a dead
    // card buys free food every Saturday. Proven in production 2026-08-15: he was skipped, the other
    // 11 cooked, zero false positives.
    const d = cookDecision(sub({ id: 'sub_zac', email: 'zacechristensen@gmail.com', open_invoices: 1 }), cutoff);
    assert.equal(d.cook, false);
    assert.equal(d.reason, 'unpaid_invoice');
    assert.match(d.message, /1 unpaid invoice/);
  });

  test('past_due with the card already fixed is still fed', () => {
    // Daniel, 2026-08-15: past_due on Saturday morning, paid in the meantime, cooked. The bound is
    // the open invoice, never the status.
    const d = cookDecision(sub({ open_invoices: 0 }), cutoff);
    assert.equal(d.cook, true);
  });

  test('a legacy sub with no real tier is skipped and surfaced, not locked empty', () => {
    const d = cookDecision(sub({ meals_per_week: 0 }), cutoff);
    assert.equal(d.cook, false);
    assert.equal(d.reason, 'needs_enrichment');
    assert.match(d.message, /needs enrichment/);
  });

  test('the enrichment check runs before the others, so a broken row reports the real reason', () => {
    const d = cookDecision(sub({ meals_per_week: null, cancel_at_period_end: 1, open_invoices: 3 }), cutoff);
    assert.equal(d.reason, 'needs_enrichment');
  });

  test('a signup after the cutoff is withheld when the cutoff is an ISO string', () => {
    // They paid for the FOLLOWING Sunday and anchored to the next Saturday. Sweeping them into this
    // cook hands them a free week of auto-filled meals they never picked. Morgan signed up 9:58am
    // Sat 2026-08-08, after the lock, and correctly belonged to 2026-08-16.
    const morgan = sub({ id: 'sub_morgan', created_at: '2026-08-08T15:58:00.000Z' });
    const d = cookDecision(morgan, cutoff);
    assert.equal(d.cook, false);
    assert.equal(d.reason, 'after_cutoff');
  });

  test('a signup before the cutoff is fed', () => {
    assert.equal(cookDecision(sub({ created_at: '2026-08-07T23:00:00.000Z' }), cutoff).cook, true);
  });

  test('post-cutoff guard fires when handed an ISO string, and is dead when handed a Date', () => {
    // LIVE BUG 2026-08-12 to 2026-09-09, FIXED on Brycen's explicit yes. lock-week.js used to pass
    // `cutoffForWeek(weekOf)`, a Date, into a comparison against `sub.created_at`, an ISO-8601 string
    // out of D1. JavaScript's relational operators coerce both operands to numbers when they are not
    // both strings, the ISO string becomes NaN, and NaN >= anything is false, so the rule never fired
    // for anybody. lock-week.js now passes `.toISOString()`, exactly what payment-order-audit.js
    // always did. Both halves stay pinned: the Date form documents the failure so nobody reintroduces
    // it, the string form is the behaviour the lock now has (Morgan, signed up after the 2026-08-08
    // cutoff, correctly waits for 2026-08-16).
    const cutoffAsDate = cutoffForWeek('2026-08-09');
    const morgan = sub({ created_at: '2026-08-08T15:58:00.000Z' });
    assert.equal(cookDecision(morgan, cutoffAsDate).cook, true, 'a Date silently disables the guard; never pass one');
    assert.equal(cookDecision(morgan, cutoffAsDate.toISOString()).cook, false, 'the ISO string is what lock-week.js passes now');
  });
});

// ================================================================================================
// B. WHO GETS CHARGED. Anchors and the payment-to-delivery mapping, billing_day.js.
// ================================================================================================
describe('who gets charged: the billing anchor', () => {
  test('(a) billing lands Saturday 07:15 UTC, the day before delivery (15:00 until 2026-09-06)', () => {
    // Hand-written from the weekly cycle in gainz-train/CLAUDE.md, not recomputed. The hour moved
    // on 2026-09-06 ("bill at the lock"): the anchor now sits 45 minutes BEFORE the 08:00 lock so the
    // lock can charge the draft before it commits food. It used to sit seven and a half hours AFTER.
    assert.equal(anchorForDelivery('2026-08-09').toISOString(), '2026-08-08T07:15:00.000Z');
    assert.equal(anchorForDelivery('2026-08-02').toISOString(), '2026-08-01T07:15:00.000Z');
  });

  test('billing always lands AFTER the ordering cutoff and BEFORE delivery', () => {
    for (const week of ['2026-07-12', '2026-07-26', '2026-08-02', '2026-08-09', '2026-11-08']) {
      const cutoff = cutoffForWeek(week).getTime();
      const anchor = anchorForDelivery(week).getTime();
      const delivery = Date.parse(`${week}T00:00:00Z`);
      assert.ok(anchor > cutoff, `${week}: billing must follow the cutoff`);
      assert.ok(anchor < delivery, `${week}: billing must precede delivery`);
    }
  });

  test('a Saturday renewal buys TOMORROW, not next week', () => {
    // Moving billing past the Friday cutoff broke the old derivation. orderableWeek() reports the
    // NEXT week once the cutoff has passed, so reading a Saturday renewal that way would have given
    // Luis, Zac, Jameson and Alyssa the 2026-08-09 delivery free. Caught in a dry run 2026-08-02.
    assert.equal(deliveryBoughtBy(new Date('2026-08-08T15:00:05Z'), 'subscription_cycle'), '2026-08-09');
    assert.equal(deliveryBoughtBy(new Date('2026-08-01T15:00:05Z'), 'subscription_cycle'), '2026-08-02');
  });

  test('a signup buys the week that was orderable when they checked out', () => {
    // Bob Viveiros paid Mon 2026-08-03 and his food came 2026-08-09.
    assert.equal(deliveryBoughtBy(new Date('2026-08-03T17:00:00Z'), 'subscription_create'), '2026-08-09');
    // Jeferson paid Thu 2026-07-23, before that Friday's cutoff, so it bought 2026-07-26.
    assert.equal(deliveryBoughtBy(new Date('2026-07-23T18:00:00Z'), 'subscription_create'), '2026-07-26');
  });

  test('the payment check refuses to judge before the anchor has fired', () => {
    // Judging payment before billing would flag the entire roster and teach everyone to ignore the
    // alert. With the 07:15 anchor the 13:00 pre-shop pass is now on the RIGHT side of billing, which
    // is the point: it judges money the same morning the food is shopped.
    assert.equal(paymentCheckReady('2026-08-09', new Date('2026-08-08T06:30:00Z')), false);
    assert.equal(paymentCheckReady('2026-08-09', new Date('2026-08-08T07:15:00Z')), false, 'needs the settle window');
    assert.equal(paymentCheckReady('2026-08-09', new Date('2026-08-08T07:34:00Z')), false);
    assert.equal(paymentCheckReady('2026-08-09', new Date('2026-08-08T07:36:00Z')), true);
    assert.equal(paymentCheckReady('2026-08-09', new Date('2026-08-08T13:00:00Z')), true, 'the pre-shop pass now judges money');
    assert.equal(paymentCheckReady('2026-08-09', new Date('2026-08-08T17:00:00Z')), true, 'the post-billing pass');
  });
});

// ================================================================================================
// C. WHAT THE RECONCILER FLAGS. payment-order-audit.js, Saturday 13:00 and 17:00 UTC.
// ================================================================================================
describe('what the reconciler flags', () => {
  test('(a) active subscription with a paid invoice: clean', () => {
    const r = report({
      weekOf: '2026-08-09',
      locked: [lockedOrder()],
      invoices: [paidInvoice()],
    });
    assert.equal(r.issue_count, 0);
    assert.equal(r.paid_and_cooked, 1);
    assert.equal(r.cooking_for, 1);
    assert.equal(r.payment_check_ran, true);
  });

  test('a 100% off comp renewal still counts as a bought week', () => {
    // The one real risk in the 2026-08-08 fix was breaking Brycen's and Marissa's OWNERS100 comps.
    // A comp is $0 BECAUSE of a discount; that is what separates it from a cancellation.
    assert.equal(invoiceCoversDelivery(compInvoice()), 'comp');
    const r = report({
      weekOf: '2026-08-09',
      locked: [lockedOrder({ stripe_subscription_id: 'sub_marissa', first_name: 'Marissa', last_name: 'Wood', total_meals: 6 })],
      invoices: [compInvoice({ subscription: 'sub_marissa' })],
    });
    assert.equal(r.issue_count, 0);
    assert.equal(r.paid_and_cooked, 1);
  });

  test('a $0 comp with no discount field but a discounts array still counts', () => {
    assert.equal(invoiceCoversDelivery(compInvoice({ discount: null, discounts: [{ id: 'di_1' }] })), 'comp');
  });

  test('a $0 invoice that no discount explains buys nothing', () => {
    assert.equal(invoiceCoversDelivery(cancellationInvoice()), null);
  });

  test('a real charge reads as paid regardless of anything else on the invoice', () => {
    assert.equal(invoiceCoversDelivery(paidInvoice()), 'paid');
  });

  test('an invoice with no subscription is skipped, not miscounted', () => {
    const { map, counted } = paidWeeksFromInvoices([paidInvoice({ subscription: null })]);
    assert.equal(map.size, 0);
    assert.equal(counted, 0);
  });

  test('the subscription id is read from the relocated Stripe path too', () => {
    // Stripe moved invoice.subscription to invoice.parent.subscription_details.subscription with no
    // error and no warning. The old path just returns null.
    const relocated = paidInvoice({ subscription: undefined, parent: { subscription_details: { subscription: 'sub_stripe_test' } } });
    const { map } = paidWeeksFromInvoices([relocated]);
    assert.ok(map.get('sub_stripe_test')?.get('2026-08-09'), 'relocated field must still resolve');
  });

  test('newest evidence wins when two invoices cover the same week', () => {
    // Stripe returns newest first and the caller preserves that order.
    const { map } = paidWeeksFromInvoices([
      paidInvoice({ id: 'in_newer', amount_paid: 10500 }),
      paidInvoice({ id: 'in_older', amount_paid: 9500 }),
    ]);
    assert.equal(map.get('sub_stripe_test').get('2026-08-09').id, 'in_newer');
  });

  test('(c) an unpaid customer who was correctly withheld shows up as paying_but_not_locked', () => {
    // The guard skipped Zac, so he has no locked order. The reconciler sees an active-family
    // subscription with nothing on the cook list and says so, which is what makes the skip visible
    // rather than a silent disappearance.
    const r = report({
      weekOf: '2026-08-09',
      locked: [lockedOrder()],
      missing: [missingRow({ sub_status: 'past_due', first_name: 'Zac', last_name: 'Christensen', meals_per_week: 6 })],
      invoices: [paidInvoice()],
    });
    assert.deepEqual(typesIn(r), ['paying_but_not_locked']);
    assert.equal(issueFor(r, 'Zac Christensen').meals, 6);
  });

  test('(d) status active but no invoice covers this week: flagged, never silently fed', () => {
    // The lock cannot know this. Billing has not run when the cook list is built, so the ONLY thing
    // standing between an unpaid week and a loss is this report.
    const r = report({
      weekOf: '2026-08-09',
      locked: [lockedOrder({ sub_status: 'active', total_meals: 14 })],
      invoices: [],
    });
    assert.deepEqual(typesIn(r), ['locked_but_not_paid']);
    assert.equal(r.paid_and_cooked, 0);
    assert.match(r.issues[0].detail, /NO paid invoice covers that week/);
  });

  test('a canceled subscription in the cook list is flagged even when payment evidence exists', () => {
    // Independent tripwire, deliberately not routed through the invoice logic. A cancellation that
    // lands between the lock and billing commits food nothing pays for, and one human glance is
    // cheap next to that.
    const r = report({
      weekOf: '2026-08-09',
      locked: [lockedOrder({ sub_status: 'canceled', total_meals: 14 })],
      invoices: [paidInvoice({ amount_paid: 11900 })],
    });
    assert.deepEqual(typesIn(r), ['canceled_but_cooking']);
    assert.equal(r.paid_and_cooked, 1, 'the payment is real, the tripwire is separate');
    assert.match(r.issues[0].detail, /\$119\.00/);
  });

  test('an order stuck in pending says so, and names the status', () => {
    const r = report({
      weekOf: '2026-08-09',
      locked: [lockedOrder()],
      missing: [missingRow({ order_status: 'pending' })],
      invoices: [paidInvoice()],
    });
    assert.match(issueFor(r, 'Test Customer').detail, /'pending', not locked/);
  });

  test('a skipped payment check is never reported as clean', () => {
    // "0 issues because we did not look" and "0 issues because everybody paid" must not read the
    // same. A check that cannot see its input must report that it did not look.
    const r = report({
      weekOf: '2026-08-09',
      locked: [lockedOrder(), lockedOrder({ subscription_id: 'sub_b', stripe_subscription_id: 'sub_stripe_b' })],
      invoices: [],
      billingSettled: false,
    });
    assert.equal(r.payment_check_ran, false);
    assert.equal(r.cooking_for, 2, 'the roster is still reported');
    assert.deepEqual(typesIn(r), [], 'no payment verdict is reached');
    assert.match(r.note, /not judged yet/);
  });

  test('the order-side half still runs before billing settles', () => {
    const r = report({
      weekOf: '2026-08-09',
      locked: [lockedOrder()],
      missing: [missingRow({ first_name: 'Jameson', last_name: '' })],
      billingSettled: false,
    });
    assert.deepEqual(typesIn(r), ['paying_but_not_locked']);
  });

  test('a truncated invoice scan warns instead of reading as clean', () => {
    const r = report({ weekOf: '2026-08-09', locked: [lockedOrder()], invoices: [paidInvoice()], truncated: true });
    assert.match(r.warning, /page cap/);
  });

  test('ordering still open: the audit refuses to judge', () => {
    const r = notLockedReport('2026-08-09');
    assert.equal(r.status, 'not_locked_yet');
    assert.equal(r.issue_count, 0);
  });

  test('cutoff passed with nothing locked is ONE loud failure, not N quiet ones', () => {
    const r = lockNeverRanReport('2026-08-09');
    assert.equal(r.status, 'lock_never_ran');
    assert.equal(r.issue_count, 1);
    assert.equal(r.issues[0].type, 'lock_never_ran');
    assert.match(r.issues[0].detail, /the lock cron did not run/);
  });
});

// ================================================================================================
// D. THE FOUR FALSE-CLEAN WEEKS, REPLAYED.
// Each one is the roster as it actually stood, run through today's rules. Every assertion is a week
// the old check called clean.
// ================================================================================================
describe('the four false-clean weeks', () => {
  test('FALSE-CLEAN 1, delivery 2026-07-12: Jameson paid and the kitchen had no order for him', () => {
    // The lock cron fired a day early on its day-of-week field, so his order row was never written.
    // health_2026-07-11.json recorded verdict PASS for this week: 8 active subscriptions, 6 locked
    // orders, 49 meals, and nothing anywhere said the other two were missing.
    const r = report({
      weekOf: '2026-07-12',
      locked: [
        lockedOrder({ stripe_subscription_id: 'sub_a', first_name: 'Destiny', last_name: 'Pedro-Smith', total_meals: 7 }),
        lockedOrder({ stripe_subscription_id: 'sub_b', first_name: 'Josh', last_name: 'Singh', total_meals: 7 }),
      ],
      missing: [
        missingRow({ first_name: 'Jameson', last_name: 'Herrera', meals_per_week: 10, order_status: null }),
      ],
      invoices: [
        paidInvoice({ id: 'in_destiny', subscription: 'sub_a', amount_paid: 7350, subtotal: 7350, total: 7350, created: Math.floor(Date.parse('2026-07-11T15:00:05Z') / 1000) }),
        paidInvoice({ id: 'in_josh', subscription: 'sub_b', amount_paid: 8350, subtotal: 8350, total: 8350, created: Math.floor(Date.parse('2026-07-11T15:00:05Z') / 1000) }),
        // Jameson's $105 is in Stripe. Nothing in D1 points at it.
        paidInvoice({ id: 'in_jameson', subscription: 'sub_jameson', amount_paid: 10500, subtotal: 10500, total: 10500, created: Math.floor(Date.parse('2026-07-11T15:00:05Z') / 1000) }),
      ],
    });
    assert.equal(r.paid_and_cooked, 2);
    assert.deepEqual(typesIn(r), ['paying_but_not_locked']);
    const jameson = issueFor(r, 'Jameson Herrera');
    assert.equal(jameson.order_status, 'none');
    assert.match(jameson.detail, /no order at all/);
  });

  test('FALSE-CLEAN 2, delivery 2026-07-26: Jeferson paid $119 and his order never left pending', () => {
    // He paid Thu 2026-07-23, which bought the week of 07-26. The order sat 'pending' instead of
    // 'locked', so the kitchen never cooked it. One payment, one week of food, knocked a week out
    // of phase, and that phase error is what set up FALSE-CLEAN 3.
    const paidJul23 = paidInvoice({
      id: 'in_jeferson_0723', subscription: 'sub_jeferson',
      amount_paid: 11900, subtotal: 11900, total: 11900,
      billing_reason: 'subscription_create',
      created: Math.floor(Date.parse('2026-07-23T18:00:00Z') / 1000),
    });
    // The payment maps to the week he was ordering for, hand-checked against the ledger.
    assert.equal(deliveryBoughtBy(new Date('2026-07-23T18:00:00Z'), 'subscription_create'), '2026-07-26');

    const r = report({
      weekOf: '2026-07-26',
      locked: [lockedOrder({ stripe_subscription_id: 'sub_a', first_name: 'Jaime', last_name: 'Esquivel', total_meals: 6 })],
      missing: [missingRow({ first_name: 'Jeferson', last_name: 'Guerreiro', meals_per_week: 14, order_status: 'pending' })],
      invoices: [
        paidJul23,
        paidInvoice({ id: 'in_jaime', subscription: 'sub_a', amount_paid: 7300, subtotal: 7300, total: 7300, created: Math.floor(Date.parse('2026-07-25T15:00:05Z') / 1000) }),
      ],
    });
    assert.deepEqual(typesIn(r), ['paying_but_not_locked']);
    const jeferson = issueFor(r, 'Jeferson Guerreiro');
    assert.equal(jeferson.order_status, 'pending');
    assert.match(jeferson.detail, /the kitchen will not cook it/);
  });

  test('FALSE-CLEAN 3, delivery 2026-08-02: Jeferson ate 14 meals on a VOIDED renewal while reading active', () => {
    // The old check asked "does this customer look unhealthy?" He passed every proxy: subscription
    // 'active', no open invoice, because the unpaid week had been VOIDED rather than left
    // outstanding. It reported 0 mismatches the morning he collected $119 of food.
    //
    // A voided invoice never appears in a status:'paid' list, so today's check finds no coverage
    // and says so. The fixture gives him the healthiest possible subscription on purpose: if the
    // code ever regresses to a health test, this is the assertion that fails.
    const r = report({
      weekOf: '2026-08-02',
      locked: [
        lockedOrder({ stripe_subscription_id: 'sub_jeferson', first_name: 'Jeferson', last_name: 'Guerreiro', total_meals: 14, sub_status: 'active' }),
        lockedOrder({ stripe_subscription_id: 'sub_a', first_name: 'Jaime', last_name: 'Esquivel', total_meals: 6 }),
      ],
      invoices: [
        // Jaime renewed normally on 2026-08-01. Jeferson's 07-30 renewal was voided, so it is absent.
        paidInvoice({ id: 'in_jaime', subscription: 'sub_a', amount_paid: 7300, subtotal: 7300, total: 7300, created: Math.floor(Date.parse('2026-08-01T15:00:05Z') / 1000) }),
      ],
    });
    assert.deepEqual(typesIn(r), ['locked_but_not_paid']);
    const jeferson = issueFor(r, 'Jeferson Guerreiro');
    assert.equal(jeferson.meals, 14);
    assert.equal(jeferson.sub_status, 'active', 'the subscription looked perfectly healthy');
    assert.match(jeferson.detail, /check for a voided or failed renewal/);
    assert.equal(r.paid_and_cooked, 1);
  });

  test('FALSE-CLEAN 4, delivery 2026-08-09: Luis Soto cooked on a $0 cancellation invoice read as paid', () => {
    // The whole roster from _data/gt/money_vs_food_audit_2026-08-08.md. Before the fix the audit
    // reported "12 cooking, 10 paid, 2 issues" and filed Luis inside the 10. After: 12 cooking,
    // 9 paid, 3 issues, with the comps untouched. Those numbers are the assertion.
    const inv = (id, subscription, cents, createdIso = '2026-08-08T15:00:05Z', over = {}) => paidInvoice({
      id, subscription, amount_paid: cents, subtotal: cents, total: cents,
      created: Math.floor(Date.parse(createdIso) / 1000), ...over,
    });
    const ord = (subscription, first, last, meals, over = {}) =>
      lockedOrder({ stripe_subscription_id: subscription, first_name: first, last_name: last, total_meals: meals, ...over });

    const r = report({
      weekOf: '2026-08-09',
      locked: [
        ord('sub_jeferson', 'Jeferson', 'Guerreiro', 14),
        ord('sub_jameson', 'Jameson', 'Herrera', 10),
        ord('sub_destiny', 'Destiny', 'Pedro-Smith', 7),
        ord('sub_josh', 'Josh', 'Singh', 7),
        ord('sub_jaime', 'Jaime', 'Esquivel', 6),
        ord('sub_stephen', 'Stephen', '', 10, { sub_status: 'trialing' }),
        ord('sub_bob', 'Bob', 'Viveiros', 6, { sub_status: 'trialing' }),
        ord('sub_marissa', 'Marissa', 'Wood', 6),
        ord('sub_brycen', 'Brycen', 'Wood', 6),
        ord('sub_daniel', 'Daniel', 'Esquivel', 14, { sub_status: 'past_due' }),
        ord('sub_luis', 'Luis', 'Soto', 14, { sub_status: 'canceled' }),
        ord('sub_zac', 'Zac', 'Christensen', 6, { sub_status: 'past_due' }),
      ],
      invoices: [
        // Five renewals that really collected money.
        inv('in_jeferson', 'sub_jeferson', 11900),
        inv('in_jameson', 'sub_jameson', 10500),
        inv('in_destiny', 'sub_destiny', 7350),
        inv('in_josh', 'sub_josh', 8350),
        inv('in_jaime', 'sub_jaime', 7300),
        // Two signups that prepaid for this delivery.
        inv('in_stephen', 'sub_stephen', 9500, '2026-08-02T20:00:00Z', { billing_reason: 'subscription_create' }),
        inv('in_bob', 'sub_bob', 3150, '2026-08-03T17:00:00Z', { billing_reason: 'subscription_create' }),
        // Two OWNERS100 comps: $0 BECAUSE of a 100% off coupon. These must survive.
        compInvoice({ id: 'in_marissa', subscription: 'sub_marissa' }),
        compInvoice({ id: 'in_brycen', subscription: 'sub_brycen' }),
        // Luis: the subscription ENDED at 15:00, and Stripe raised a $0 invoice that reads
        // status 'paid' with billing_reason 'subscription_cycle'. Byte for byte the same as the two
        // comps above on both of those fields. It bought nothing.
        cancellationInvoice({ id: 'in_luis', subscription: 'sub_luis' }),
        // Daniel and Zac declined. Their invoices are 'open', so they never reach this list at all.
      ],
    });

    assert.equal(r.cooking_for, 12);
    assert.equal(r.paid_and_cooked, 9, 'the 9 legitimate ones, comps included');
    assert.equal(r.issue_count, 3);

    const byName = Object.fromEntries(r.issues.map((i) => [i.name, i]));
    assert.deepEqual(Object.keys(byName).sort(), ['Daniel Esquivel', 'Luis Soto', 'Zac Christensen']);
    assert.equal(byName['Luis Soto'].type, 'locked_but_not_paid');
    assert.equal(byName['Luis Soto'].meals, 14);
    assert.equal(byName['Daniel Esquivel'].meals, 14);
    assert.equal(byName['Zac Christensen'].meals, 6);

    // The comps are the one thing the fix could have broken, so name them.
    assert.ok(!byName['Marissa Wood'], 'the OWNERS100 comp must not be flagged');
    assert.ok(!byName['Brycen Wood'], 'the OWNERS100 comp must not be flagged');

    // 34 meals across the three, worth $311 at the prices in the audit note.
    assert.equal(r.issues.reduce((s, i) => s + i.meals, 0), 34);
    assert.equal(r.zero_value_invoices_ignored, 1, "Luis's cancellation invoice, and only that one");
  });

  test('regression guard: an amount test would erase the comps and a billing_reason test would pass Luis', () => {
    // Both of the tempting simplifications, spelled out. The comp and the cancellation are
    // identical on status and billing_reason; only the discount separates them.
    const comp = compInvoice({ subscription: 'sub_brycen' });
    const cancel = cancellationInvoice({ subscription: 'sub_luis' });

    assert.equal(comp.billing_reason, cancel.billing_reason);
    assert.equal(comp.amount_paid, cancel.amount_paid);
    assert.equal(comp.status, cancel.status);

    // An amount test would drop the comp.
    assert.equal(comp.amount_paid > 0, false);
    // A billing_reason test would keep the cancellation.
    assert.equal(cancel.billing_reason === 'subscription_cycle', true);
    // The discount test gets both right.
    assert.equal(invoiceCoversDelivery(comp), 'comp');
    assert.equal(invoiceCoversDelivery(cancel), null);
  });
});

// ================================================================================================
// E. BILL AT THE LOCK (2026-09-06). Stripe drafts each renewal at Sat 07:15 UTC; the lock at 08:00
// UTC charges the draft BEFORE it writes the order as locked. These cases pin the new per-customer
// decision (lockAction on a LIVE subscription) and the outcome mapping (chargeOutcome), plus the
// replays of the four weeks that leaked under the old order: Jeferson, Luis, Destiny, Stephen.
// ================================================================================================
describe('bill at the lock: anchor, lock decision, charge outcome', () => {
  const weekOf = '2026-09-13';                                   // first Saturday under the new order
  const anchor = anchorForDelivery(weekOf);                      // Sat 2026-09-12 07:15Z
  const lockTime = new Date('2026-09-12T08:00:00Z');
  const sec = (iso) => Math.floor(Date.parse(iso) / 1000);
  const nextSat = sec('2026-09-19T07:15:00Z');
  const oldHourToday = sec('2026-09-12T15:00:00Z');

  // A live Stripe subscription as GET /v1/subscriptions/:id returns it (period end on the ITEM).
  function liveSub(over = {}) {
    const { periodEnd = nextSat, ...rest } = over;
    return { id: 'sub_live', status: 'active', pause_collection: null, cancel_at_period_end: false,
      items: { data: [{ current_period_end: periodEnd }] }, ...rest };
  }
  // This cycle's draft, created at the anchor.
  function draft(over = {}) {
    return { id: 'in_draft', status: 'draft', created: sec('2026-09-12T07:15:20Z'), period_start: sec('2026-09-12T07:15:00Z'),
      billing_reason: 'subscription_cycle', ...over };
  }
  const act = (live, d, policies = LOCK_POLICY_DEFAULTS) => lockAction({ live, draft: d, weekOf, now: lockTime, policies });

  test('the anchor is Saturday 07:15 UTC, before the 08:00 lock, after the cutoff in BOTH time zones', () => {
    assert.equal(ANCHOR_HOUR_UTC, 7);
    assert.equal(ANCHOR_MINUTE_UTC, 15);
    assert.equal(anchor.toISOString(), '2026-09-12T07:15:00.000Z');
    // MDT week: cutoff Sat 06:00Z, 75 minutes before the anchor.
    assert.equal(cutoffForWeek('2026-09-13').toISOString(), '2026-09-12T06:00:00.000Z');
    // MST week (after 2026-11-01): cutoff Sat 07:00Z, still 15 minutes before the anchor, which is
    // more than moveToBillingDay's 5 minute MIN_LEAD, so a resume at 06:59Z is not refused.
    assert.equal(cutoffForWeek('2026-11-08').toISOString(), '2026-11-07T07:00:00.000Z');
    assert.equal(anchorForDelivery('2026-11-08').toISOString(), '2026-11-07T07:15:00.000Z');
    const gapMin = (anchorForDelivery('2026-11-08') - cutoffForWeek('2026-11-08')) / 60000;
    assert.ok(gapMin > 5 && gapMin === 15, `MST cutoff-to-anchor gap is ${gapMin} min`);
    // The lock runs 08:00Z: after the anchor, so drafts exist.
    assert.ok(lockTime > anchor);
  });

  test('the same-day hour shift moves 15:00 to 07:15 on the SAME Saturday, never another day', () => {
    const moved = anchorOnSameDay(new Date('2026-09-12T15:00:00Z'));
    assert.equal(moved.toISOString(), '2026-09-12T07:15:00.000Z');
    assert.equal(anchorOnSameDay(new Date('2026-09-12T23:59:59Z')).toISOString(), '2026-09-12T07:15:00.000Z');
  });

  test('period end is read from the ITEM first (the flat field relocated)', () => {
    assert.equal(livePeriodEndMs(liveSub()), nextSat * 1000);
    assert.equal(livePeriodEndMs({ current_period_end: nextSat }), nextSat * 1000);
    assert.equal(livePeriodEndMs({}), null);
  });

  test('DESTINY REPLAY, the rule in his words: paused BEFORE the lock is skipped, even with a draft', () => {
    // Destiny paused 13 minutes after the 15:00 draft on 09-05; the lock had run at 07:30 and the
    // void landed at 16:01. Under the new order, a pause between the 07:15 anchor and the 08:00 lock
    // shows pause_collection on the LIVE read while the draft still sits there (Stripe voids it at
    // its own finalization, about an hour later). The lock must skip and let Stripe void.
    const d = act(liveSub({ pause_collection: { behavior: 'void' } }), draft());
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, 'paused_before_lock');
    assert.match(d.message, /not cooked/);
  });

  test('DESTINY REPLAY, the other half: not paused at 08:00 means charge, then lock, then notify', () => {
    // Had she paused at 09:13 under the new order the invoice would already be paid ("invoices
    // created before you pause continue to be retried unless you void them", Stripe docs). The lock
    // sees an active sub with a rolled period and a draft: charge it.
    const d = act(liveSub(), draft());
    assert.equal(d.action, 'charge');
    assert.equal(d.reason, 'draft_ready');
  });

  test('LUIS REPLAY: a cancel queued before the anchor has already canceled the sub by lock time', () => {
    // Luis queued cancel_at_period_end on Thursday. Under the new order the period ends at 07:15
    // Saturday and Stripe cancels there; at 08:00 the live status is 'canceled' and no draft exists.
    const d = act(liveSub({ status: 'canceled', cancel_at_period_end: true, periodEnd: sec('2026-09-12T07:15:00Z') }), null);
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, 'canceled_before_lock');
  });

  test('a cancel queued AFTER the anchor (period already rolled, draft live) is charged and cooked by default', () => {
    // The inversion the grader caught: skipping this one is "charged, not fed", because Stripe will
    // finalize and charge the draft at ~08:15 whether or not we cook. Default policy: their last week.
    const d = act(liveSub({ cancel_at_period_end: true }), draft());
    assert.equal(d.action, 'charge');
    assert.equal(d.reason, 'queued_cancel_last_week');
  });

  test('the same cancel under the void policy voids the draft and skips (Decision 2, the other fork)', () => {
    const d = act(liveSub({ cancel_at_period_end: true }), draft(), { declined: 'cook', queuedCancel: 'void' });
    assert.equal(d.action, 'void');
  });

  test('period rolled but no draft yet is RETRY, not "paused": two different facts', () => {
    // Stripe lag was under a minute on 09-05 (26 drafts 15:00:03 to 15:01:02) but the plan does not
    // depend on that. No row is written; pass 2 at 08:30 re-reads.
    const d = act(liveSub(), null);
    assert.equal(d.action, 'retry');
    assert.equal(d.reason, 'no_draft_yet');
  });

  test('a live read that failed is RETRY, never a skip and never a charge', () => {
    assert.equal(act(null, draft()).action, 'retry');
  });

  test('an anchor that never moved (period still ends 15:00 today) takes the LEGACY path and is flagged', () => {
    // The migration missed this sub, or a resume landed on the old hour. Old behaviour, named.
    const d = act(liveSub({ periodEnd: oldHourToday }), null);
    assert.equal(d.action, 'legacy');
    assert.equal(d.reason, 'anchor_not_moved');
    assert.match(d.message, /LEGACY/);
  });

  test('a status outside COOKABLE is skipped and says which status', () => {
    const d = act(liveSub({ status: 'unpaid' }), draft());
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, 'status_unpaid');
  });

  test('pickCycleDraft takes this Saturday\'s draft and ignores a stale one and non-drafts', () => {
    const stale = draft({ id: 'in_old', created: sec('2026-09-05T15:00:56Z'), period_start: sec('2026-09-05T15:00:00Z') });
    const paid = draft({ id: 'in_paid', status: 'paid' });
    const chosen = pickCycleDraft([stale, paid, draft()], weekOf);
    assert.equal(chosen.id, 'in_draft');
    assert.equal(pickCycleDraft([stale], weekOf), null);
    assert.equal(pickCycleDraft([], weekOf), null);
    assert.equal(pickCycleDraft(null, weekOf), null);
  });

  test('chargeOutcome reads the re-fetched invoice, because the wrapper throws on a decline', () => {
    assert.equal(chargeOutcome({ status: 'paid', amount_paid: 9150 }), 'paid');
    assert.equal(chargeOutcome({ status: 'paid', amount_paid: 0, subtotal: 6300, total: 0, discount: { coupon: { id: 'OWNERS100' } } }), 'comp');
    assert.equal(chargeOutcome({ status: 'open', amount_paid: 0, attempt_count: 1 }), 'declined');
    assert.equal(chargeOutcome({ status: 'uncollectible' }), 'declined');
    assert.equal(chargeOutcome({ status: 'void' }), 'void');
    assert.equal(chargeOutcome({ status: 'draft' }), 'draft');
    assert.equal(chargeOutcome(null), 'unknown');
  });

  test('feedAfterCharge: paid and comp cook; declined follows Decision 1; void and unknown write nothing', () => {
    assert.deepEqual(feedAfterCharge('paid'), { cook: true, charge_status: 'paid', order_status: 'locked' });
    assert.deepEqual(feedAfterCharge('comp'), { cook: true, charge_status: 'comp', order_status: 'locked' });
    // Default: cook and chase. Rule 2 (open invoice) blocks them NEXT week, so a dead card buys one week.
    assert.deepEqual(feedAfterCharge('declined'), { cook: true, charge_status: 'declined', order_status: 'locked' });
    // No pay, no food: the row is still written, as unpaid_not_cooked, so it is visible and re-runnable.
    assert.deepEqual(feedAfterCharge('declined', { declined: 'withhold', queuedCancel: 'cook' }),
      { cook: false, charge_status: 'declined', order_status: 'unpaid_not_cooked' });
    assert.equal(feedAfterCharge('void').order_status, null);
    assert.equal(feedAfterCharge('unknown').order_status, null);
    assert.equal(feedAfterCharge('draft').order_status, null);
  });

  test('policies default to cook/cook and flip only on the exact env values', () => {
    assert.deepEqual(lockPolicies({}), { declined: 'cook', queuedCancel: 'cook' });
    assert.deepEqual(lockPolicies({ LOCK_DECLINED_POLICY: 'withhold' }), { declined: 'withhold', queuedCancel: 'cook' });
    assert.deepEqual(lockPolicies({ LOCK_QUEUED_CANCEL_POLICY: 'void' }), { declined: 'cook', queuedCancel: 'void' });
    assert.deepEqual(lockPolicies({ LOCK_DECLINED_POLICY: 'yes' }), { declined: 'cook', queuedCancel: 'cook' });
  });

  test('the payment check is ready 20 minutes after the NEW anchor, so the 13:00 audit judges money', () => {
    assert.equal(paymentCheckReady(weekOf, new Date('2026-09-12T07:30:00Z')), false);
    assert.equal(paymentCheckReady(weekOf, new Date('2026-09-12T07:36:00Z')), true);
    assert.equal(paymentCheckReady(weekOf, new Date('2026-09-12T13:00:00Z')), true);
  });

  test('a Saturday 07:15 renewal still buys TOMORROW\'s Sunday', () => {
    assert.equal(deliveryBoughtBy(new Date('2026-09-12T07:15:30Z'), 'subscription_cycle'), '2026-09-13');
    assert.equal(deliveryBoughtBy(new Date('2026-09-12T08:00:30Z'), 'subscription_cycle'), '2026-09-13');
  });
});
