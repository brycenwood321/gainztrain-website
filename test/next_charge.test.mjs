// The Home card's "about $X" must add the same lines the lock bills. Board finding M5 (2026-09-16):
// the first draft left the specialty upcharge out, so a customer with a specialty pick would have
// read a number lower than what landed on their card. Run: npm test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { nextChargeEstimate } from '../functions/_lib/estimate.js';

describe('nextChargeEstimate', () => {
  test('meals plus delivery, no extras', () => {
    const r = nextChargeEstimate({ mealsPerWeek: 10, perMealCents: 990, deliveryFeeCents: 1000 });
    assert.equal(r.meals_cents, 9900);
    assert.equal(r.amount_cents, 10900);
    assert.equal(r.approx, true);
  });
  test('a specialty pick raises the estimate by exactly the upcharge the lock bills', () => {
    const base = nextChargeEstimate({ mealsPerWeek: 10, perMealCents: 990, deliveryFeeCents: 0 });
    const spec = nextChargeEstimate({ mealsPerWeek: 10, perMealCents: 990, deliveryFeeCents: 0, upchargeCents: 3 * 150 });
    assert.equal(spec.amount_cents - base.amount_cents, 450);
    assert.equal(spec.upcharge_cents, 450);
  });
  test('a pending 4-meal referral credit comes off meals, never delivery', () => {
    const r = nextChargeEstimate({ mealsPerWeek: 6, perMealCents: 1000, deliveryFeeCents: 1500, pendingCreditMeals: 4 });
    assert.equal(r.credit_cents, 4000);
    assert.equal(r.amount_cents, 6000 - 4000 + 1500);
  });
  test('a credit larger than the meal charges is capped at the meal charges', () => {
    const r = nextChargeEstimate({ mealsPerWeek: 6, perMealCents: 1000, deliveryFeeCents: 1500, pendingCreditMeals: 12 });
    assert.equal(r.credit_cents, 6000);
    assert.equal(r.amount_cents, 1500);
  });
  test('a percent discount applies to meals only', () => {
    const r = nextChargeEstimate({ mealsPerWeek: 10, perMealCents: 1000, deliveryFeeCents: 1000, discountPct: 15 });
    assert.equal(r.meals_cents, 8500);
    assert.equal(r.amount_cents, 9500);
  });
  test('garbage never goes negative', () => {
    const r = nextChargeEstimate({ mealsPerWeek: -3, perMealCents: null, deliveryFeeCents: -5 });
    assert.equal(r.amount_cents, 0);
  });
});
