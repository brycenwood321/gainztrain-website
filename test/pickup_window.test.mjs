// THE PICKUP WINDOW CANNOT HALF SHIP. Run: npm test
//
// The window is defined once in functions/_lib/pickup.js and appears in four customer messages and on
// four static pages. On 2026-08-23 it was cut to 45 minutes; the pause wave started three days later
// and 11 of the 13 paused by 09-13 were pickup customers. Plan rev 4 (D1) widens it from 09-20 if
// Brycen says yes by Thu 09-17. That flip is ONE list entry, and these tests are what make it whole:
//
//   - every SMS string stays inside plain ASCII (an en-dash once doubled the billed segments)
//   - the window for a Sunday comes from the entry in force ON that Sunday, not from "now"
//   - the four static pages say what the config says for the upcoming Sunday
//   - the announcement refuses to send for a Sunday that is not a cutover
//
// Expected strings below are written by hand from the history in pickup.js, never recomputed through
// the helper under test (memory: two-sides-of-a-check-same-source).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PICKUP, PICKUP_WINDOWS, pickupFor, windowFor, changeOn, upcomingSundayISO, pickupSentence,
} from '../functions/_lib/pickup.js';
import { checkPages } from '../scripts/pickup_window.mjs';
import { TEMPLATES } from '../functions/_lib/notify_templates.js';

const ASCII = /^[\x20-\x7E]*$/;
const env = { SITE_URL: 'https://gainztrainprep.com' };

describe('window history', () => {
  test('the first entry is the 2026-08-23 45-minute window and dates before it fall back to it', () => {
    assert.equal(PICKUP_WINDOWS[0].from, '2026-08-23');
    assert.equal(windowFor('2026-08-23').label, '10:00am–10:45am');
    assert.equal(windowFor('2026-01-04').label, '10:00am–10:45am');
    assert.equal(windowFor('2026-09-13').sms, '10:00am-10:45am');   // the last Sunday before D1 could land
  });
  test('entries are Sundays in ascending order', () => {
    let prev = '';
    for (const w of PICKUP_WINDOWS) {
      assert.ok(w.from > prev, `${w.from} is not after ${prev}`);
      assert.equal(new Date(w.from + 'T00:00:00Z').getUTCDay(), 0, `${w.from} is not a Sunday`);
      prev = w.from;
    }
  });
  test('the first entry is never a cutover', () => {
    assert.equal(changeOn('2026-08-23'), null);
    assert.equal(changeOn('2026-09-13'), null);
  });
  test('upcomingSundayISO lands on a Sunday and never in the past', () => {
    const s = upcomingSundayISO(new Date('2026-09-14T15:00:00Z'));
    assert.equal(s, '2026-09-20');
    assert.equal(upcomingSundayISO(new Date('2026-09-20T23:59:00Z')), '2026-09-20');
  });
});

describe('SMS safety', () => {
  test('every SMS string is plain ASCII', () => {
    for (const w of PICKUP_WINDOWS) {
      assert.match(w.sms, ASCII, `${w.from} sms`);
      assert.match(w.lengthSms, ASCII, `${w.from} lengthSms`);
      const p = pickupFor(w.from);
      assert.match(p.smsLine, ASCII, `${w.from} smsLine`);
      assert.match(p.addressSms, ASCII);
    }
  });
  test('the reminder and ready texts are plain ASCII for every window', () => {
    for (const w of PICKUP_WINDOWS) {
      const d = { weekOf: w.from, firstName: 'Zac' };
      assert.match(TEMPLATES.pickup_reminder(d, env).sms, ASCII);
      assert.match(TEMPLATES.order_pickup_ready(d, env).sms, ASCII);
    }
  });
});

describe('messages read the window for THEIR Sunday', () => {
  test('order_locked, ready and reminder for 2026-09-13 all say 10:00am-10:45am', () => {
    const d = { weekOf: '2026-09-13', method: 'pickup', meals: [], total: 0, firstName: 'Zac' };
    assert.match(TEMPLATES.order_locked(d, env).sms, /Sun 10:00am-10:45am/);
    assert.match(TEMPLATES.order_pickup_ready(d, env).sms, /Sun 10:00am-10:45am/);
    assert.match(TEMPLATES.pickup_reminder(d, env).sms, /TODAY 10:00am-10:45am/);
    assert.match(TEMPLATES.pickup_reminder(d, env).sms, /45 min window/);
    assert.match(pickupSentence('2026-09-13'), /10:00am–10:45am/);
  });
  test('PICKUP (the back-compat object) is the upcoming Sunday, computed on access', () => {
    const p = pickupFor(upcomingSundayISO());
    assert.equal(PICKUP.windowLabel, p.windowLabel);
    assert.equal(PICKUP.smsLine, p.smsLine);
    assert.equal(PICKUP.addressLine, '149 N State St, Suite B, Orem');
  });
  test('pickup_change refuses a Sunday that is not a cutover', () => {
    assert.throws(() => TEMPLATES.pickup_change({ weekOf: '2026-09-13', when: 'tomorrow' }, env), /not a pickup window cutover/);
  });
  test('when a later window exists, the announcement for its first Sunday names both windows', { skip: PICKUP_WINDOWS.length < 2 }, () => {
    const prev = PICKUP_WINDOWS[PICKUP_WINDOWS.length - 2];
    const next = PICKUP_WINDOWS[PICKUP_WINDOWS.length - 1];
    const out = TEMPLATES.pickup_change({ weekOf: next.from, when: 'tomorrow', firstName: 'Zac' }, env);
    assert.match(out.sms, ASCII);
    assert.ok(out.sms.includes(next.sms), 'sms carries the new window');
    assert.ok(out.sms.includes(prev.sms), 'sms carries the old window');
    assert.ok(out.html.includes(next.label) && out.html.includes(prev.label), 'email carries both');
    // the Saturday before the cutover already tells people the NEW window
    assert.ok(TEMPLATES.order_locked({ weekOf: next.from, method: 'pickup', meals: [], total: 0 }, env).sms.includes(next.sms));
    // and the Sunday before it still says the OLD one
    const dayBefore = new Date(next.from + 'T00:00:00Z'); dayBefore.setUTCDate(dayBefore.getUTCDate() - 7);
    assert.ok(TEMPLATES.pickup_reminder({ weekOf: dayBefore.toISOString().slice(0, 10) }, env).sms.includes(prev.sms));
  });
});

describe('static pages', () => {
  test('every page says what the config says for the upcoming Sunday (run scripts/pickup_window.mjs --render if not)', () => {
    const c = checkPages();
    assert.deepEqual(c.wrong, [], JSON.stringify(c.wrong, null, 1));
  });
  test('the markers are all present: contact 1, subscribe 1, faqs 3, delivery 1', () => {
    const c = checkPages();
    const count = (page, kind) => c.found.filter((f) => f.page === page && (!kind || f.kind === kind)).length;
    assert.equal(count('contact.html'), 1);
    assert.equal(count('subscribe/index.html'), 1);
    assert.equal(count('faqs/index.html', 'window'), 2);
    assert.equal(count('faqs/index.html', 'length'), 1);
    assert.equal(count('delivery/index.html'), 1);
  });
});
