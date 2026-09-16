// QA pass, slice one: money edges on nextChargeEstimate, the retention reminder cutoff, and the
// validation profile.js leans on (toE164 + str). profile.js itself needs D1, so its branches are
// checked here by driving the same helpers with the same inputs it would pass them. Run: npm test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nextChargeEstimate } from '../functions/_lib/estimate.js';
import { creditAmountCents } from '../functions/_lib/credits.js';
import { reminderCutoffIso } from '../functions/api/admin/retention.js';
import { toE164, str } from '../functions/_lib/validate.js';

describe('4. money: nextChargeEstimate edges', () => {
  test('100 percent comp with a pending credit: mirrors credits.js exactly (remaining = min(draft total, list meals))', () => {
    // The lock caps at min(draft.total, perMeal * meals). A comp draft totals only the delivery line, so
    // the lock WOULD credit against it; the estimate must say what the lock does, not what policy wishes.
    const r = nextChargeEstimate({ mealsPerWeek: 10, perMealCents: 990, deliveryFeeCents: 1000, discountPct: 100, pendingCreditMeals: 4 });
    assert.equal(r.meals_cents, 0);
    assert.equal(r.credit_cents, creditAmountCents(4, 990, Math.min(1000, 9900)));
    assert.equal(r.amount_cents, 1000 - r.credit_cents);
  });
  test('perMealCents 0 with pending credit meals: credit is 0, never negative, total is delivery', () => {
    const r = nextChargeEstimate({ mealsPerWeek: 10, perMealCents: 0, deliveryFeeCents: 1500, pendingCreditMeals: 4 });
    assert.equal(r.credit_cents, 0); assert.equal(r.amount_cents, 1500);
    assert.ok(Number.isInteger(r.amount_cents));
  });
  test('discount over 100 clamps to 100, negative discount is ignored', () => {
    assert.equal(nextChargeEstimate({ mealsPerWeek: 10, perMealCents: 1000, discountPct: 150 }).meals_cents, 0);
    assert.equal(nextChargeEstimate({ mealsPerWeek: 10, perMealCents: 1000, discountPct: -20 }).meals_cents, 10000);
  });
  test('fractional inputs truncate meals and rate, round the credit, and every output is an integer', () => {
    const r = nextChargeEstimate({ mealsPerWeek: 10.7, perMealCents: 990.9, deliveryFeeCents: 999.5, upchargeCents: 150.4, pendingCreditMeals: 2.5, discountPct: 33.333 });
    for (const k of ['amount_cents', 'meals_cents', 'upcharge_cents', 'delivery_fee_cents', 'credit_cents']) assert.ok(Number.isInteger(r[k]), `${k} = ${r[k]}`);
    assert.equal(r.meals_cents, Math.round(9900 * (1 - 33.333 / 100)));
    assert.equal(r.delivery_fee_cents, 999); assert.equal(r.upcharge_cents, 150);
    assert.equal(r.credit_cents, Math.round(2.5 * 990));
  });
  test('upcharge with zero meals: the upcharge alone is billed, and a credit is capped at what the lock would cap it at', () => {
    const r = nextChargeEstimate({ mealsPerWeek: 0, perMealCents: 990, deliveryFeeCents: 0, upchargeCents: 450, pendingCreditMeals: 4 });
    assert.equal(r.meals_cents, 0); assert.equal(r.upcharge_cents, 450);
    // credits.js applyCreditsToDraft caps at perMeal * meals_per_week (never the upcharge): 0 here.
    assert.equal(r.credit_cents, 0, 'estimate credits the upcharge; the lock never does');
    assert.equal(r.amount_cents, 450);
  });
  test('credit larger than meals on a plan WITH an upcharge: estimate cap must equal the lock cap (meals only)', () => {
    const r = nextChargeEstimate({ mealsPerWeek: 6, perMealCents: 1000, deliveryFeeCents: 1500, upchargeCents: 450, pendingCreditMeals: 12 });
    const lockCap = creditAmountCents(12, 1000, Math.min(6000 + 450 + 1500, 6 * 1000));
    assert.equal(r.credit_cents, lockCap, `estimate ${r.credit_cents} vs lock ${lockCap}`);
  });
  test('strings and NaN in the inputs never produce NaN out', () => {
    const r = nextChargeEstimate({ mealsPerWeek: '10', perMealCents: 'abc', deliveryFeeCents: NaN, upchargeCents: undefined, pendingCreditMeals: 'x' });
    for (const k of ['amount_cents', 'meals_cents', 'credit_cents']) assert.ok(Number.isFinite(r[k]), `${k} = ${r[k]}`);
  });
  test('huge inputs (> 2^31 cents) do not wrap negative through |0', () => {
    const r = nextChargeEstimate({ mealsPerWeek: 10, perMealCents: 3_000_000_000 });
    assert.ok(r.amount_cents >= 0);
    assert.equal(r.amount_cents, 30_000_000_000, 'a 30 million dollar rate is absurd, but silently wrapping is worse');
  });
  test('creditAmountCents: fractional meals round, negative remaining is 0', () => {
    assert.equal(creditAmountCents(1.5, 990, 100000), 1485);
    assert.equal(creditAmountCents(4, 990, -5), 0);
    assert.equal(creditAmountCents('4', '990', '5000'), 3960);
  });
});

describe('4b. retention reminderCutoffIso edges', () => {
  test('a week_of that is not a Sunday still gives the Wednesday 4 days before it (no snap)', () => {
    assert.equal(reminderCutoffIso('2026-09-21'), '2026-09-17T17:00:00.000Z');
  });
  test('the DST fall-back week and the year boundary', () => {
    assert.equal(reminderCutoffIso('2026-11-01'), '2026-10-28T17:00:00.000Z');
    assert.equal(reminderCutoffIso('2027-01-03'), '2026-12-30T17:00:00.000Z');
  });
  test('garbage week_of throws on toISOString rather than returning Invalid Date silently', () => {
    assert.throws(() => reminderCutoffIso('not-a-week'), RangeError);
  });
});

describe('profile.js validation, by its helpers', () => {
  test('toE164 accepts the phone shapes a customer types', () => {
    assert.equal(toE164('(801) 555-1234'), '+18015551234');
    assert.equal(toE164('801.555.1234'), '+18015551234');
    assert.equal(toE164('1 801 555 1234'), '+18015551234');
    assert.equal(toE164('+1 801 555 1234'), '+18015551234');
    assert.equal(toE164('+44 20 7946 0958'), '+442079460958');
  });
  test('toE164 rejects garbage', () => {
    assert.equal(toE164('555-1234'), '');
    assert.equal(toE164('abc'), '');
    assert.equal(toE164('+0 801 555 1234'), '');
    assert.equal(toE164(''), '');
    assert.equal(toE164(null), '');
    assert.equal(toE164(8015551234), '', 'a JSON number is not a string, so it clears rather than saves');
  });
  test('toE164 accepts numerically plausible but not real numbers (documents the ceiling of the check)', () => {
    assert.equal(toE164('0000000000'), '+10000000000');
    assert.equal(toE164('+8015551234'), '+8015551234', 'a US number typed with + but no 1 keeps the wrong country code');
  });
  test('str coerces every non-string to empty, which is what profile.js relies on for first_name', () => {
    assert.equal(str(123), ''); assert.equal(str(null), ''); assert.equal(str({ a: 1 }), ''); assert.equal(str(['x']), '');
  });
  test('profile.js source: the branches the helpers imply', () => {
    const src = readFileSync(new URL('../functions/api/account/profile.js', import.meta.url), 'utf8');
    assert.match(src, /if \(firstName === ''\) return fail\(400, 'no_first_name'/, 'empty first name is refused');
    assert.match(src, /body\.first_name !== undefined \? str\(body\.first_name\)/, 'a null or numeric first_name becomes "" and is refused');
    assert.match(src, /phone = toE164\(raw\); if \(!phone\) return fail\(400, 'invalid_phone'/, 'garbage phone is refused');
    assert.match(src, /else phone = ''/, 'empty phone clears');
    assert.match(src, /firstName === null && lastName === null && phone === null\) return fail\(400, 'nothing_to_save'/, 'empty body is refused');
    assert.match(src, /\.slice\(0, 80\)/, 'names are capped at 80');
    assert.doesNotMatch(src, /lastName === ''\)/, 'last_name "" is allowed to clear (COALESCE keeps "")');
    // readJson returns whatever JSON.parse gives: a body of literal `null` makes body.first_name throw.
    assert.match(src, /const body = \(await readJson\(request\)\) \|\| \{\};/, 'body must be null-guarded before it is dereferenced');
  });
});

describe('index.html render paths, static review', () => {
  const html = readFileSync(new URL('../app/next/index.html', import.meta.url), 'utf8');
  test('every homeState string goes through esc() before innerHTML', () => {
    for (const f of ['c.headline', 'c.sub', 'c.note.text', 'c.cta.href', 'c.cta.label', 's.label', 'm.name', 'm.image']) assert.match(html, new RegExp('esc\\(' + f.replace(/\./g, '\\.') + '\\)'), f);
  });
  test('the meals qty and the plan meals_per_week are interpolated raw (numbers only, so a null shows as the word null)', () => {
    assert.match(html, /×\$\{m\.qty\}/);
    assert.match(html, /\$\{s\.meals_per_week\} meals a week/);
  });
  test('the next-charge row hides while paused and re-labels under a queued cancel', () => {
    assert.match(html, /me\.next_charge && s\.status !== 'paused'/);
    assert.match(html, /s\.cancel_at_period_end \? 'Last charge' : 'Next charge'/);
  });
  test('the eyebrow week label is suppressed for the five billing states', () => {
    assert.match(html, /\['no_plan', 'plan_ended', 'paused', 'past_due_hold', 'past_due_cooks'\]\.includes\(h\.state\) \? '' : weekLabel/);
  });
  test('the next card toggles on h.next and the greeting uses the Mountain clock helper', () => {
    assert.match(html, /if \(h\.next\)/); assert.match(html, /gtGreeting\(c\.first_name, Date\.now\(\)\)/);
  });
});
