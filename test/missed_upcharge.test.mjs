// The 2026-09-19 missed-upcharge cleanup: what gets billed, to whom, for exactly which meals.
// Fixtures are the real rows from that morning (audit_log upcharge_missed_settled, meal_selections).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { upchargeLines, upchargeTotal, upchargeMemo, missedUpchargePlan } from '../functions/_lib/upcharge_bill.js';
import { TEMPLATES } from '../functions/_lib/notify_templates.js';

const sel = (position, name, qty, per) => ({ meal_position: position, meal_name: name, qty, upcharge_per_meal_cents: per });

describe('missed upcharge: lines and totals', () => {
  test('one line per specialty meal with qty, name and per-meal price; plain meals are not lines', () => {
    const lines = upchargeLines([
      sel(1, 'Tomato Chicken with Cilantro Lime Rice', 4, 0),
      sel(3, 'Steak Fajita With Cilantro Lime rice', 2, 150),
      sel(5, 'Fall Spice Yogurt Parfait', 3, 100),
      sel(6, 'Beef Sweet Potato', 0, 200),
    ]);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].description, '2x Steak Fajita With Cilantro Lime rice, specialty upcharge $1.50 per meal');
    assert.equal(lines[0].cents, 300);
    assert.equal(lines[1].cents, 300);
    assert.equal(upchargeTotal(lines), 600);
  });

  test('the memo says what it is, that it is only the upcharge, and names the delivery day', () => {
    const memo = upchargeMemo('2026-09-20');
    assert.match(memo, /Sunday, Sep 20/);
    assert.match(memo, /only that upcharge/);
    assert.match(memo, /by mistake on our side/);
  });
});

describe('missed upcharge: who gets billed', () => {
  const lines = upchargeLines([sel(3, 'Steak Fajita', 2, 150)]);
  const locked = { status: 'locked', charge_status: 'paid' };

  test('a paid, locked customer with specialty meals is billed the selection total', () => {
    const p = missedUpchargePlan({ audited: 300, order: locked, alreadyRow: null, lines });
    assert.deepEqual(p, { bill: true, cents: 300, mismatch: null });
  });
  test('a comp is never billed (Jayson and Alyssa on 2026-09-19)', () => {
    assert.equal(missedUpchargePlan({ audited: 650, order: { status: 'locked', charge_status: 'comp' }, alreadyRow: null, lines }).reason, 'comp');
  });
  test('already billed is a no-op, so a re-run cannot double charge', () => {
    assert.equal(missedUpchargePlan({ audited: 300, order: locked, alreadyRow: { id: 9 }, lines }).reason, 'already_billed');
  });
  test('no locked order means nothing to bill', () => {
    assert.equal(missedUpchargePlan({ audited: 300, order: null, alreadyRow: null, lines }).reason, 'no_locked_order');
    assert.equal(missedUpchargePlan({ audited: 300, order: { status: 'pending', charge_status: null }, alreadyRow: null, lines }).reason, 'no_locked_order');
  });
  test('no specialty meals on the selections means nothing to bill, whatever the audit row said', () => {
    assert.equal(missedUpchargePlan({ audited: 300, order: locked, alreadyRow: null, lines: [] }).reason, 'no_specialty_meals');
  });
  test('when the audit row and the selections disagree, the selections win and the gap is reported', () => {
    const p = missedUpchargePlan({ audited: 450, order: locked, alreadyRow: null, lines });
    assert.equal(p.cents, 300);
    assert.deepEqual(p.mismatch, { audited: 450, fromSelections: 300 });
  });
});

describe('missed upcharge: the receipt names every meal', () => {
  test('upcharge_receipt lists each meal with its amount and the total', () => {
    const r = TEMPLATES.upcharge_receipt({
      amount: 600, weekOf: '2026-09-20', invoiceUrl: 'https://invoice.stripe.com/x',
      meals: [{ name: 'Steak Fajita', qty: 2, cents: 300 }, { name: 'Fall Spice Yogurt Parfait', qty: 3, cents: 300 }],
    }, {});
    assert.match(r.subject, /\$6\.00 specialty upcharge/);
    assert.match(r.html, /2x Steak Fajita/);
    assert.match(r.html, /3x Fall Spice Yogurt Parfait/);
    assert.match(r.html, /Total/);
    assert.match(r.html, /left off by mistake on our side/);
    assert.match(r.html, /invoice\.stripe\.com\/x/);
    assert.equal(r.sms, undefined, 'email only: receipts are not on the SMS allowlist');
  });
});
