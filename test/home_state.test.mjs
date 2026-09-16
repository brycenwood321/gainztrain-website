// homeState is the one computation behind the customer Home card. These fixtures cover the nine clean
// states AND the overlaps a table cannot supply its own answer for (memory
// tests-that-supply-their-own-answer): past due with a queued cancel, paused with a queued cancel,
// cancel scheduled on a locked week. Precedence follows functions/_lib/decide.js. Run: npm test
//
// app/next/assets/home_state.js is a classic browser script, so it is evaluated in a vm context here
// rather than imported (the page has no module scripts and needs the function as a global).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../app/next/assets/home_state.js', import.meta.url), 'utf8');
const ctx = vm.createContext({ Intl, Date, Math });
vm.runInContext(src, ctx);
const homeState = vm.runInContext('homeState', ctx);
const greeting = vm.runInContext('greeting', ctx);

// Wednesday 2026-09-16 10:00 Mountain (16:00Z). Orderable week 2026-09-20, cutoff Fri 2026-09-19 05:59:59Z.
const WED = Date.parse('2026-09-16T16:00:00Z');
// Saturday 2026-09-19 09:00 Mountain, the blackout: orderable week rolled to 09-27, the 09-20 order is locked.
const SAT = Date.parse('2026-09-19T15:00:00Z');
// Sunday 2026-09-20 13:00 Mountain, delivery day: 09-27 is orderable and open.
const SUN = Date.parse('2026-09-20T19:00:00Z');

const sub = (o = {}) => ({ status: 'active', meals_per_week: 10, per_meal_cents: 990, current_period_end: '2026-09-19T07:15:00Z', cancel_at_period_end: false, ...o });
const me = (o = {}) => ({ customer: { first_name: 'Jake', delivery_method: 'pickup' }, subscription: sub(), orders: [], meal_history: [], open_invoices: 0, pickup: { windowLabel: '10:00 to 10:45 am', addressShort: '149 N State St, Orem' }, ...o });
const menuOpen = (o = {}) => ({ week_of: '2026-09-20', has_menu: true, locked: false, ordering_closed: false, cutoff: '2026-09-19T05:59:59.999Z', meals_per_week: 10, selections: [], meals: [{ position: 1, name: 'Chicken Bowl' }, { position: 2, name: 'Ziti' }], ...o });
const menuBlackout = { week_of: '2026-09-27', has_menu: false, locked: true, ordering_closed: true, cutoff: '2026-09-26T05:59:59.999Z', meals_per_week: 10, selections: [] };

describe('the nine clean states', () => {
  test('no plan', () => {
    const r = homeState(me({ subscription: null }), menuOpen(), WED);
    assert.equal(r.state, 'no_plan'); assert.equal(r.cta.href, '/start/');
  });
  test('plan ended', () => {
    const r = homeState(me({ subscription: sub({ status: 'canceled' }) }), menuOpen(), WED);
    assert.equal(r.state, 'plan_ended');
  });
  test('open, nothing picked: names the cutoff and the days left', () => {
    const r = homeState(me(), menuOpen(), WED);
    assert.equal(r.state, 'open_unpicked');
    assert.match(r.sub, /Pick by Friday 11:59 pm, 2 days left/);
    assert.match(r.sub, /10 meals for Sunday, Sep 20/);
    assert.equal(r.cta.label, 'Pick meals');
  });
  test('open, partly picked', () => {
    const r = homeState(me(), menuOpen({ selections: [{ meal_position: 1, qty: 4 }] }), WED);
    assert.equal(r.state, 'open_partial'); assert.match(r.headline, /4 of 10/);
  });
  test('open, all picked: lists the meals and offers Edit', () => {
    const r = homeState(me(), menuOpen({ selections: [{ meal_position: 1, qty: 6 }, { meal_position: 2, qty: 4 }] }), WED);
    assert.equal(r.state, 'open_picked'); assert.equal(r.cta.label, 'Edit meals');
    assert.deepEqual(r.meals.map((m) => [m.name, m.qty]), [['Chicken Bowl', 6], ['Ziti', 4]]);
  });
  test('menu not posted yet', () => {
    const r = homeState(me(), menuOpen({ has_menu: false }), WED);
    assert.equal(r.state, 'menu_not_posted');
  });
  test('locked on Saturday: tracks the 09-20 order and offers next week underneath', () => {
    const m = me({ orders: [{ week_of: '2026-09-20', delivery_status: 'scheduled', total_meals: 10 }] });
    const r = homeState(m, menuBlackout, SAT);
    assert.equal(r.state, 'delivery_locked');
    assert.match(r.sub, /10 meals\. Ready for pickup Sunday, Sep 20/);
    assert.equal(r.tracker.steps[0].now, true);
    assert.ok(r.next, 'a next-week card exists during the blackout');
  });
  test('ready for pickup on Sunday shows the window, and next week is open to pick', () => {
    const m = me({ orders: [{ week_of: '2026-09-20', delivery_status: 'pickup_ready', total_meals: 10 }] });
    const r = homeState(m, menuOpen({ week_of: '2026-09-27', cutoff: '2026-09-26T05:59:59.999Z' }), SUN);
    assert.equal(r.state, 'delivery_ready');
    assert.match(r.sub, /10:00 to 10:45 am at 149 N State St/);
    assert.equal(r.next.state, 'open_unpicked'); assert.match(r.next.headline, /Pick next week/);
  });
  test('delivered', () => {
    const m = me({ customer: { first_name: 'Jake', delivery_method: 'delivery' }, orders: [{ week_of: '2026-09-20', delivery_status: 'delivered', delivered_at: '2026-09-20T17:14:00Z', total_meals: 10 }] });
    const r = homeState(m, menuOpen({ week_of: '2026-09-27' }), SUN);
    assert.equal(r.state, 'delivered'); assert.match(r.sub, /11:14/);
    assert.equal(r.tracker.steps[3].now, true);
  });
});

describe('the states the billing code decides', () => {
  test('paused beats everything else', () => {
    const r = homeState(me({ subscription: sub({ status: 'paused' }) }), menuOpen(), WED);
    assert.equal(r.state, 'paused'); assert.equal(r.cta.label, 'Resume my plan');
  });
  test('past due WITH an open invoice: meals on hold (decide.js:66 withholds)', () => {
    const r = homeState(me({ subscription: sub({ status: 'past_due' }), open_invoices: 1 }), menuOpen(), WED);
    assert.equal(r.state, 'past_due_hold'); assert.match(r.sub, /on hold/);
  });
  test('past due with the invoice settled: meals still cook (COOKABLE includes past_due)', () => {
    const r = homeState(me({ subscription: sub({ status: 'past_due' }), open_invoices: 0 }), menuOpen(), WED);
    assert.equal(r.state, 'past_due_cooks'); assert.match(r.sub, /still cook/);
  });
  test('trialing is a live plan, never shown as a trial', () => {
    const r = homeState(me({ subscription: sub({ status: 'trialing' }) }), menuOpen(), WED);
    assert.equal(r.state, 'open_unpicked');
    assert.ok(!/trial/i.test(r.headline + r.sub));
  });
});

describe('overlaps a table cannot answer', () => {
  test('past due plus a queued cancel: past due wins, the cancel is a note', () => {
    const r = homeState(me({ subscription: sub({ status: 'past_due', cancel_at_period_end: true }), open_invoices: 1 }), menuOpen(), WED);
    assert.equal(r.state, 'past_due_hold'); assert.match(r.note.text, /ends after/);
  });
  test('paused plus a queued cancel: paused wins, the cancel is a note', () => {
    const r = homeState(me({ subscription: sub({ status: 'paused', cancel_at_period_end: true }) }), menuOpen(), WED);
    assert.equal(r.state, 'paused'); assert.match(r.note.text, /ends after Saturday, Sep 19/);
  });
  test('a queued cancel that ends before the orderable week: NO pick card, the cancel card with Undo (review P1)', () => {
    // Billed Sat 09-12, cancelled Wed 09-16, period ends Sat 09-19 07:15Z: Stripe will not renew, so the
    // 09-20 week is never charged or cooked. The old fixture put the period end a week later and hid this.
    const m = me({ subscription: sub({ cancel_at_period_end: true }), orders: [{ week_of: '2026-09-13', delivery_status: 'picked_up', total_meals: 10 }] });
    const r = homeState(m, menuOpen(), WED);
    assert.equal(r.state, 'cancel_scheduled');
    assert.match(r.sub, /last delivery is Sunday, Sep 13/);
    assert.equal(r.cta.label, 'Undo cancellation');
    assert.ok(!/Pick/.test(r.headline + (r.cta && r.cta.label)));
  });
  test('cancel queued AFTER the Saturday charge, pointing at next Saturday: this week tracks, next week is the cancel card', () => {
    const m = me({ subscription: sub({ cancel_at_period_end: true, current_period_end: '2026-09-26T07:15:00Z' }), orders: [{ week_of: '2026-09-20', delivery_status: 'prepping', total_meals: 10 }] });
    const r = homeState(m, menuBlackout, SAT);
    assert.equal(r.state, 'delivery_prepping'); assert.match(r.note.text, /ends after Saturday, Sep 26/);
    assert.equal(r.next.state, 'cancel_scheduled'); assert.match(r.next.sub, /last delivery is Sunday, Sep 20/);
  });
  test('unpaid reads as a card issue, never a pick card (decide.js COOKABLE excludes it)', () => {
    const r = homeState(me({ subscription: sub({ status: 'unpaid' }), open_invoices: 1 }), menuOpen(), WED);
    assert.equal(r.state, 'past_due_hold');
  });
  test('a settled past-due card with meals already out: the tracker wins and the card issue is a red note', () => {
    const m = me({ subscription: sub({ status: 'past_due', current_period_end: '2026-09-26T07:15:00Z' }), open_invoices: 0, customer: { first_name: 'Jake', delivery_method: 'delivery' }, orders: [{ week_of: '2026-09-20', delivery_status: 'out_for_delivery', total_meals: 10 }] });
    const r = homeState(m, menuBlackout, SAT);
    assert.equal(r.state, 'delivery_out'); assert.equal(r.note.tone, 'red'); assert.match(r.note.text, /Card issue/);
  });
  test('a delivery customer sees the delivery flow labels', () => {
    const m = me({ subscription: sub({ current_period_end: '2026-09-26T07:15:00Z' }), customer: { first_name: 'Jake', delivery_method: 'delivery' }, orders: [{ week_of: '2026-09-20', delivery_status: 'scheduled', total_meals: 10 }] });
    const r = homeState(m, menuBlackout, SAT);
    assert.equal(JSON.stringify(r.tracker.steps.map((x) => x.label)), JSON.stringify(['Locked', 'Cooking', 'On the way', 'Delivered']));
    assert.match(r.sub, /Arriving Sunday, Sep 20/);
  });
  test('a locked week with NO order (signed up after the cutoff) says when ordering opens', () => {
    const r = homeState(me(), menuBlackout, SAT);
    assert.equal(r.state, 'menu_not_posted'); assert.match(r.headline, /opens Sunday/);
  });
});

describe('greeting', () => {
  test('uses the Mountain-time hour and the first name', () => {
    assert.equal(greeting('Jake', WED), 'Morning, Jake');
    assert.equal(greeting('Jake', SUN), 'Afternoon, Jake');
    assert.equal(greeting('', Date.parse('2026-09-16T02:00:00Z')), 'Evening');
  });
});
