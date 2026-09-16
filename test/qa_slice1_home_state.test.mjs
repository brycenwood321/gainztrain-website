// QA pass, slice one: homeState from angles the fixture file does not cover. Happy paths past the nine
// clean states, garbage input, edge instants (cutoff, DST, local midnight), determinism, no mutation,
// and a copy audit over every reachable state. Run: npm test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../app/next/assets/home_state.js', import.meta.url), 'utf8');
const ctx = vm.createContext({ Intl, Date, Math });
vm.runInContext(src, ctx);
const homeState = vm.runInContext('homeState', ctx);
const greeting = vm.runInContext('greeting', ctx);
const sundayOnOrAfter = vm.runInContext('sundayOnOrAfter', ctx);

// Instants (Mountain Daylight Time is UTC-6 in September).
const WED = Date.parse('2026-09-16T16:00:00Z');            // Wed 10:00 MDT
const SAT = Date.parse('2026-09-19T15:00:00Z');            // Sat 09:00 MDT, blackout
const SAT_2359 = Date.parse('2026-09-20T05:59:00Z');       // Sat 23:59 MDT
const SUN_0000 = Date.parse('2026-09-20T06:00:00Z');       // Sun 00:00 MDT
const SUN = Date.parse('2026-09-20T19:00:00Z');            // Sun 13:00 MDT
const SUN_1830 = Date.parse('2026-09-21T00:30:00Z');       // Sun 18:30 MDT (UTC already Monday)
const SUN_2359 = Date.parse('2026-09-21T05:59:00Z');       // Sun 23:59 MDT
const MON_0000 = Date.parse('2026-09-21T06:00:00Z');       // Mon 00:00 MDT
const MON = Date.parse('2026-09-21T16:00:00Z');            // Mon 10:00 MDT
const CUTOFF = Date.parse('2026-09-19T05:59:59.999Z');     // Fri 23:59:59.999 MDT

const sub = (o = {}) => ({ status: 'active', meals_per_week: 10, per_meal_cents: 990, current_period_end: '2026-09-26T07:15:00Z', cancel_at_period_end: false, ...o });
const me = (o = {}) => ({ customer: { first_name: 'Jake', delivery_method: 'pickup' }, subscription: sub(), orders: [], meal_history: [], open_invoices: 0, pickup: { windowLabel: '10:00 to 10:45 am', addressShort: '149 N State St, Orem' }, ...o });
const menuOpen = (o = {}) => ({ week_of: '2026-09-20', has_menu: true, locked: false, ordering_closed: false, cutoff: '2026-09-19T05:59:59.999Z', meals_per_week: 10, selections: [], meals: [{ position: 1, name: 'Chicken Bowl', image: '/img/cb.jpg' }, { position: 2, name: 'Ziti' }], ...o });
const menuNext = (o = {}) => menuOpen({ week_of: '2026-09-27', cutoff: '2026-09-26T05:59:59.999Z', ...o });
const menuBlackout = { week_of: '2026-09-27', has_menu: false, locked: true, ordering_closed: true, cutoff: '2026-09-26T05:59:59.999Z', meals_per_week: 10, selections: [] };
const order = (o = {}) => ({ week_of: '2026-09-20', delivery_status: 'scheduled', total_meals: 10, ...o });

const plain = (v) => JSON.parse(JSON.stringify(v));
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach((k) => deepFreeze(o[k])); }
  return o;
}
// Every string a customer could read from one result, top card and next card.
function allCopy(r) {
  const bits = [r.headline, r.sub, r.note && r.note.text, r.cta && r.cta.label];
  if (r.next) bits.push(r.next.headline, r.next.sub, r.next.cta && r.next.cta.label);
  if (r.tracker) r.tracker.steps.forEach((s) => bits.push(s.label));
  if (r.meals) r.meals.forEach((m) => bits.push(m.name));
  return bits.filter(Boolean).join(' | ');
}
const EM_DASH = String.fromCharCode(8212);
const FORBIDDEN = ['trialing', 'past_due', 'week_of', 'null', 'undefined', 'NaN', 'Invalid Date', EM_DASH, 'active', 'scheduled', 'pickup_ready', 'out_for_delivery'];

describe('1. happy paths beyond the fixtures', () => {
  test('delivery customer on Saturday: Arriving, delivery flow labels, next-week card', () => {
    const m = me({ customer: { first_name: 'Ana', delivery_method: 'delivery' }, orders: [order()] });
    const r = homeState(m, menuBlackout, SAT);
    assert.equal(r.state, 'delivery_locked');
    assert.match(r.sub, /^10 meals\. Arriving Sunday, Sep 20\.$/);
    assert.deepEqual(plain(r.tracker.steps.map((s) => s.label)), ['Locked', 'Cooking', 'On the way', 'Delivered']);
    assert.equal(r.next.state, 'menu_not_posted'); assert.equal(r.next.headline, 'Next week');
  });
  test('picks in meal_history for the tracked week: meals come from history, image null, menu ignored', () => {
    const m = me({ orders: [order({ delivery_status: 'prepping' })], meal_history: [{ week_of: '2026-09-20', meal_name: 'Chicken Bowl', qty: 6 }, { week_of: '2026-09-20', meal_name: 'Ziti', qty: 4 }, { week_of: '2026-09-13', meal_name: 'Old', qty: 9 }, { week_of: '2026-09-20', meal_name: 'Zero', qty: 0 }] });
    const r = homeState(m, menuNext({ selections: [{ meal_position: 1, qty: 10 }] }), SUN);
    assert.equal(r.state, 'delivery_prepping');
    assert.deepEqual(plain(r.meals), [{ name: 'Chicken Bowl', qty: 6, image: null, emoji: null }, { name: 'Ziti', qty: 4, image: null, emoji: null }]);
    // next week's picks still render from the menu selections, with the menu image.
    assert.deepEqual(plain(r.next.meals), [{ name: 'Chicken Bowl', qty: 10, image: '/img/cb.jpg', emoji: null }]);
  });
  test('Sunday 18:30 Mountain (UTC is Monday): still tracks Sunday, never rolls early', () => {
    const m = me({ orders: [order({ delivery_status: 'picked_up' })] });
    const r = homeState(m, menuNext(), SUN_1830);
    assert.equal(sundayOnOrAfter(SUN_1830), '2026-09-20');
    assert.equal(r.state, 'delivered'); assert.equal(r.headline, 'Picked up');
    assert.equal(r.week_of, '2026-09-20'); assert.ok(r.next);
  });
  test('Sunday 23:59 tracks; Monday 00:00 shows only the open card', () => {
    const m = me({ orders: [order({ delivery_status: 'delivered', delivered_at: '2026-09-20T17:14:00Z' })] });
    assert.equal(homeState(m, menuNext(), SUN_2359).state, 'delivered');
    const r = homeState(m, menuNext(), MON_0000);
    assert.equal(r.state, 'open_unpicked'); assert.equal(r.tracker, null); assert.equal(r.next, null);
    assert.equal(r.week_of, '2026-09-27');
  });
  test('Monday, fresh orderable week, last week delivered: no tracker, open card only', () => {
    const m = me({ orders: [order({ delivery_status: 'delivered', delivered_at: '2026-09-20T17:14:00Z' })] });
    const r = homeState(m, menuNext(), MON);
    assert.equal(r.state, 'open_unpicked'); assert.equal(r.tracker, null); assert.equal(r.next, null); assert.equal(r.meals, null);
    assert.match(r.sub, /Pick by Friday 11:59 pm, 4 days left\. 10 meals for Sunday, Sep 27\./);
  });
  test('Saturday 23:59 and Sunday 00:00 both track the 09-20 order', () => {
    const m = me({ orders: [order({ delivery_status: 'prepping' })] });
    assert.equal(homeState(m, menuBlackout, SAT_2359).state, 'delivery_prepping');
    assert.equal(homeState(m, menuNext(), SUN_0000).state, 'delivery_prepping');
  });
});

describe('2. garbage and missing input', () => {
  test('me with no orders array on Saturday: locked week with nothing to track', () => {
    const m = me(); delete m.orders;
    const r = homeState(m, menuBlackout, SAT);
    assert.equal(r.state, 'menu_not_posted'); assert.equal(r.headline, 'Ordering opens Sunday');
  });
  test('menu null: menu coming, week_of falls back to the delivery Sunday', () => {
    const r = homeState(me(), null, WED);
    assert.equal(r.state, 'menu_not_posted'); assert.equal(r.headline, 'Menu coming'); assert.equal(r.week_of, '2026-09-20');
  });
  test('menu null on a tracked Saturday: the locked order becomes invisible (documents current behaviour)', () => {
    // With menu null there is no orderable week, so trackingWeek is null and the order is not shown.
    const r = homeState(me({ orders: [order()] }), null, SAT);
    assert.equal(r.state, 'menu_not_posted'); assert.equal(r.tracker, null);
  });
  test('selections referencing positions not on the menu still list with a placeholder name', () => {
    const r = homeState(me(), menuOpen({ selections: [{ meal_position: 7, qty: 10 }] }), WED);
    assert.equal(r.state, 'open_picked');
    assert.deepEqual(plain(r.meals), [{ name: 'Meal 7', qty: 10, image: null, emoji: null }]);
  });
  test('cutoff missing: says Friday midnight, no time left fragment', () => {
    const r = homeState(me(), menuOpen({ cutoff: null }), WED);
    assert.match(r.sub, /^Pick by Friday midnight\. 10 meals for Sunday, Sep 20\.$/);
  });
  test('cutoff in the past while ordering_closed is false: still says Pick, with no time left', () => {
    const r = homeState(me(), menuOpen(), Date.parse('2026-09-19T12:00:00Z'));
    assert.equal(r.state, 'open_unpicked');
    assert.match(r.sub, /^Pick by Friday 11:59 pm\. 10 meals/);
    assert.doesNotMatch(r.sub, /left/);
  });
  test('incomplete_expired is a dead plan; without a period end it says Come back', () => {
    const r = homeState(me({ subscription: sub({ status: 'incomplete_expired', current_period_end: null }) }), menuOpen(), WED);
    assert.equal(r.state, 'plan_ended'); assert.equal(r.sub, 'Come back any time.');
  });
  test('unpaid is a card issue, never a pick card (decided 2026-09-16: decide.js COOKABLE excludes it)', () => {
    const r = homeState(me({ subscription: sub({ status: 'unpaid' }) }), menuOpen(), WED);
    assert.ok(r.state === 'past_due_cooks' || r.state === 'past_due_hold', r.state);
  });

  test('greeting with no first name, null and undefined', () => {
    assert.equal(greeting('', WED), 'Morning');
    assert.equal(greeting(null, WED), 'Morning');
    assert.equal(greeting(undefined, SUN), 'Afternoon');
    assert.equal(greeting('Jake', Date.parse('2026-09-16T23:00:00Z')), 'Evening, Jake');
    assert.equal(greeting('Jake', Date.parse('2026-09-16T22:59:00Z')), 'Afternoon, Jake');
  });
  test('unknown delivery_status reads as Locked, step 0 current', () => {
    const r = homeState(me({ orders: [order({ delivery_status: 'teleporting' })] }), menuBlackout, SAT);
    assert.equal(r.state, 'delivery_locked'); assert.equal(r.tracker.steps[0].now, true);
    assert.doesNotMatch(allCopy(r), /teleporting/);
  });
  test('delivery_status null/empty reads as Locked', () => {
    assert.equal(homeState(me({ orders: [order({ delivery_status: null })] }), menuBlackout, SAT).state, 'delivery_locked');
    assert.equal(homeState(me({ orders: [order({ delivery_status: '' })] }), menuBlackout, SAT).state, 'delivery_locked');
  });
  test('delivered_at malformed must not throw and must not print Invalid Date', () => {
    const m = me({ orders: [order({ delivery_status: 'delivered', delivered_at: 'yesterday-ish' })] });
    let r;
    assert.doesNotThrow(() => { r = homeState(m, menuNext(), SUN); });
    assert.equal(r.state, 'delivered');
    assert.doesNotMatch(r.sub, /Invalid|NaN/);
  });
  test('current_period_end malformed with a queued cancel must not throw', () => {
    const m = me({ subscription: sub({ cancel_at_period_end: true, current_period_end: 'soon' }) });
    let r;
    assert.doesNotThrow(() => { r = homeState(m, menuOpen(), WED); });
    assert.doesNotMatch(allCopy(r), /Invalid|NaN/);
  });
  test('current_period_end malformed on a canceled plan must not throw', () => {
    const m = me({ subscription: sub({ status: 'canceled', current_period_end: 'soon' }) });
    let r;
    assert.doesNotThrow(() => { r = homeState(m, menuOpen(), WED); });
    assert.doesNotMatch(allCopy(r), /Invalid|NaN/);
  });
  test('total_meals 0 or missing drops the meal count fragment', () => {
    const r = homeState(me({ orders: [order({ total_meals: 0 })] }), menuBlackout, SAT);
    assert.match(r.sub, /^Ready for pickup Sunday, Sep 20\.$/);
  });
  test('need is 0 (no meals_per_week anywhere) with picks: never 0 meals set', () => {
    const m = me({ subscription: sub({ meals_per_week: null }) });
    const r = homeState(m, menuOpen({ meals_per_week: null, selections: [{ meal_position: 1, qty: 3 }] }), WED);
    assert.notEqual(r.state, 'open_picked');
    assert.doesNotMatch(r.headline, /0 meals/);
  });
  test('selections with qty missing or negative do not go NaN', () => {
    const r = homeState(me(), menuOpen({ selections: [{ meal_position: 1 }, { meal_position: 2, qty: -2 }] }), WED);
    assert.doesNotMatch(allCopy(r), /NaN/);
  });
  test('past_due with open_invoices missing reads as still cooks', () => {
    const m = me({ subscription: sub({ status: 'past_due' }) }); delete m.open_invoices;
    assert.equal(homeState(m, menuOpen(), WED).state, 'past_due_cooks');
  });
  test('pickup_ready with no pickup block on me falls back to the kitchen', () => {
    const m = me({ orders: [order({ delivery_status: 'pickup_ready' })], pickup: null });
    assert.equal(homeState(m, menuNext(), SUN).sub, 'Ready at the kitchen today.');
  });
});

describe('3. edge times', () => {
  test('exactly the cutoff instant: no time-left fragment; one ms before: 1 min', () => {
    const at = homeState(me(), menuOpen(), CUTOFF);
    assert.doesNotMatch(at.sub, /left/);
    const before = homeState(me(), menuOpen(), CUTOFF - 1);
    assert.match(before.sub, /1 min left/);
  });
  test('one ms after the cutoff, menu still flagged open: still says Pick (server flag decides closure)', () => {
    const r = homeState(me(), menuOpen(), CUTOFF + 1);
    assert.equal(r.state, 'open_unpicked'); assert.doesNotMatch(r.sub, /left/);
  });
  test('time-left buckets: 47h59 is 1 day, 48h is 2 days, 59 min is 59 min, 1h is 1 hour', () => {
    const c = Date.parse('2026-09-19T05:59:59.999Z');
    const sub_ = (ms) => homeState(me(), menuOpen(), c - ms).sub;
    assert.match(sub_(48 * 3600000 - 60000), /1 day left/);
    assert.match(sub_(48 * 3600000), /2 days left/);
    assert.match(sub_(59 * 60000), /59 min left/);
    assert.match(sub_(3600000), /1 hour left/);
    assert.match(sub_(2 * 3600000), /2 hours left/);
  });
  test('DST fall-back weekend 2026-11-01: sundayOnOrAfter holds across the 02:00 local change', () => {
    assert.equal(sundayOnOrAfter(Date.parse('2026-11-01T05:59:00Z')), '2026-11-01'); // Sat 23:59 MDT
    assert.equal(sundayOnOrAfter(Date.parse('2026-11-01T06:00:00Z')), '2026-11-01'); // Sun 00:00 MDT
    assert.equal(sundayOnOrAfter(Date.parse('2026-11-01T07:30:00Z')), '2026-11-01'); // Sun 01:30 MDT (first pass)
    assert.equal(sundayOnOrAfter(Date.parse('2026-11-01T08:00:00Z')), '2026-11-01'); // Sun 01:00 MST (after fall back)
    assert.equal(sundayOnOrAfter(Date.parse('2026-11-01T08:30:00Z')), '2026-11-01'); // Sun 01:30 MST (second pass)
    assert.equal(sundayOnOrAfter(Date.parse('2026-11-02T06:59:00Z')), '2026-11-01'); // Sun 23:59 MST
    assert.equal(sundayOnOrAfter(Date.parse('2026-11-02T07:00:00Z')), '2026-11-08'); // Mon 00:00 MST
  });
  test('DST spring-forward 2026-03-08: 02:00 local does not exist, Sunday still holds', () => {
    assert.equal(sundayOnOrAfter(Date.parse('2026-03-08T08:59:00Z')), '2026-03-08'); // Sun 01:59 MST
    assert.equal(sundayOnOrAfter(Date.parse('2026-03-08T09:00:00Z')), '2026-03-08'); // Sun 03:00 MDT
    assert.equal(sundayOnOrAfter(Date.parse('2026-03-09T05:59:00Z')), '2026-03-08'); // Sun 23:59 MDT
    assert.equal(sundayOnOrAfter(Date.parse('2026-03-09T06:00:00Z')), '2026-03-15'); // Mon 00:00 MDT
  });
  test('fmtCutoff on a winter (MST) cutoff still reads Friday 11:59 pm', () => {
    const r = homeState(me(), menuOpen({ week_of: '2026-12-06', cutoff: '2026-12-05T06:59:59.999Z' }), Date.parse('2026-12-02T16:00:00Z'));
    assert.match(r.sub, /Pick by Friday 11:59 pm/);
  });
  test('year boundary: week_of 2027-01-03 on 2026-12-30', () => {
    const r = homeState(me(), menuOpen({ week_of: '2027-01-03', cutoff: '2027-01-02T06:59:59.999Z' }), Date.parse('2026-12-30T16:00:00Z'));
    assert.match(r.sub, /for Sunday, Jan 3\./);
  });
});

describe('5. determinism and no mutation', () => {
  const cases = [
    ['open', () => [me(), menuOpen({ selections: [{ meal_position: 1, qty: 6 }, { meal_position: 2, qty: 4 }] }), WED]],
    ['tracked', () => [me({ orders: [order({ delivery_status: 'pickup_ready' })], meal_history: [{ week_of: '2026-09-20', meal_name: 'Ziti', qty: 10 }] }), menuNext({ selections: [{ meal_position: 2, qty: 10 }] }), SUN]],
    ['past due cancel', () => [me({ subscription: sub({ status: 'past_due', cancel_at_period_end: true }), open_invoices: 2 }), menuOpen(), WED]],
    ['no orders key', () => { const m = me(); delete m.orders; delete m.meal_history; return [m, menuBlackout, SAT]; }],
  ];
  for (const [name, mk] of cases) {
    test(`${name}: same inputs give the same output and inputs are untouched (frozen + snapshot)`, () => {
      const [m, mn, now] = mk();
      const snap = JSON.stringify([m, mn]);
      deepFreeze(m); deepFreeze(mn);
      const a = homeState(m, mn, now);
      const b = homeState(m, mn, now);
      assert.deepEqual(plain(a), plain(b));
      assert.equal(JSON.stringify([m, mn]), snap);
      // the output shares no object with the input (a page mutating the card must not touch me)
      if (a.meals && m.meal_history && m.meal_history.length) assert.notEqual(a.meals[0], m.meal_history[0]);
    });
  }
  test('now omitted or 0 uses the clock and still returns a state', () => {
    assert.ok(homeState(me(), menuOpen()).state);
    assert.ok(homeState(me(), menuOpen(), 0).state);
  });
});

describe('6. copy audit over every reachable state', () => {
  const orderStates = ['scheduled', 'prepping', 'pickup_ready', 'picked_up', 'out_for_delivery', 'delivered', 'bogus', null];
  const subs = [null, sub(), sub({ status: 'trialing' }), sub({ status: 'paused' }), sub({ status: 'past_due' }), sub({ status: 'canceled' }), sub({ status: 'incomplete' }), sub({ status: 'incomplete_expired' }), sub({ cancel_at_period_end: true }), sub({ status: 'paused', cancel_at_period_end: true }), sub({ status: 'past_due', cancel_at_period_end: true }), sub({ meals_per_week: null }), sub({ status: 'canceled', current_period_end: null })];
  const menus = [null, menuOpen(), menuOpen({ has_menu: false }), menuOpen({ selections: [{ meal_position: 1, qty: 4 }] }), menuOpen({ selections: [{ meal_position: 1, qty: 6 }, { meal_position: 9, qty: 4 }] }), menuOpen({ cutoff: null }), menuBlackout, menuNext(), menuNext({ selections: [{ meal_position: 2, qty: 10 }] }), menuOpen({ meals_per_week: null, selections: [{ meal_position: 1, qty: 2 }] })];
  const nows = [WED, SAT, SUN, SUN_1830, MON, CUTOFF, CUTOFF + 1];
  const methods = ['pickup', 'delivery', undefined];
  let n = 0; const states = new Set(); const bad = [];
  for (const s of subs) for (const mn of menus) for (const now of nows) for (const dm of methods) for (const os of orderStates) for (const oi of [0, 1]) {
    const m = me({ customer: { first_name: dm === undefined ? '' : 'Jake', delivery_method: dm }, subscription: s, open_invoices: oi, orders: os === null ? [] : [order({ delivery_status: os, delivered_at: os === 'delivered' ? '2026-09-20T17:14:00Z' : undefined, total_meals: os === 'bogus' ? undefined : 10 })], meal_history: os === 'prepping' ? [{ week_of: '2026-09-20', meal_name: 'Ziti', qty: 10 }] : [] });
    let r;
    try { r = homeState(m, mn, now); } catch (e) { bad.push(`THROWS ${e.message} [sub=${s && s.status} menu=${mn && mn.week_of} os=${os}]`); continue; }
    n++; states.add(r.state); if (r.next) states.add('next:' + r.next.state);
    const copy = allCopy(r);
    for (const f of FORBIDDEN) if (copy.includes(f)) bad.push(`${r.state}: contains "${f}" in: ${copy}`);
    if (!r.headline) bad.push(`${r.state}: empty headline`);
    if (r.week_of && !/^\d{4}-\d{2}-\d{2}$/.test(r.week_of)) bad.push(`${r.state}: week_of ${r.week_of}`);
    if (r.cta && !/^\/(start|app)\//.test(r.cta.href)) bad.push(`${r.state}: cta href ${r.cta.href}`);
  }
  test('matrix runs, covers every state, and no copy leaks an internal word', () => {
    const uniq = [...new Set(bad)];
    assert.equal(uniq.length, 0, `${uniq.length} problems over ${n} combos:\n` + uniq.slice(0, 15).join('\n'));
    for (const want of ['no_plan', 'plan_ended', 'paused', 'past_due_hold', 'past_due_cooks', 'delivery_locked', 'delivery_prepping', 'delivery_ready', 'delivery_out', 'delivered', 'open_unpicked', 'open_partial', 'open_picked', 'menu_not_posted', 'next:open_unpicked', 'next:open_picked', 'next:menu_not_posted']) assert.ok(states.has(want), `state ${want} never reached`);
  });
  test('the page eyebrow rule: billing states still carry a week_of the page can label; no plan carries none', () => {
    for (const s of [sub({ status: 'paused' }), sub({ status: 'past_due' })]) assert.ok(homeState(me({ subscription: s }), menuOpen(), WED).week_of);
    assert.equal(homeState(me({ subscription: null }), menuOpen(), WED).week_of, null);
  });
});
