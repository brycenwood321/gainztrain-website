// REFERRAL CREDITS RIDE THE LOCK, BEFORE THE CHARGE, CAPPED AT THE DRAFT. Run: npm test
//
// The referral map (2026-09-14) gave two cautions on a negative invoice item: cap it in code or Stripe
// rolls a negative balance into later weeks, and attach it in the upcharge slot or it lands on next
// week's invoice. The maths is pure and pinned here; the ordering is checked in the source, the same
// way reasons.test.mjs checks that a reason rides the status UPDATE.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { creditAmountCents, CREDIT_KINDS } from '../functions/_lib/credits.js';
import { referralCodeFor, isReferralShaped, REFERRAL_MEALS } from '../functions/_lib/referral.js';

describe('creditAmountCents', () => {
  test('2 meals at $9.50 on a $85.50 draft is $19.00', () => {
    assert.equal(creditAmountCents(2, 950, 8550), 1900);
  });
  test('never more than what is left on the draft', () => {
    assert.equal(creditAmountCents(2, 950, 1000), 1000);
    assert.equal(creditAmountCents(2, 950, 0), 0);
    assert.equal(creditAmountCents(2, 950, -5), 0);
  });
  test('garbage in, zero out', () => {
    assert.equal(creditAmountCents(undefined, 950, 8550), 0);
    assert.equal(creditAmountCents(2, null, 8550), 0);
  });
  test('the week-4 bonus is a kind on this path, not a coupon', () => {
    assert.ok(CREDIT_KINDS.week4_bonus);
    assert.ok(CREDIT_KINDS.referral_referrer && CREDIT_KINDS.referral_referred);
  });
});

describe('referral codes', () => {
  test('shape: name stem, dash, four unambiguous characters', () => {
    const c = referralCodeFor('Zac', () => 0.5);
    assert.match(c, /^ZAC-[A-HJ-NP-Z2-9]{4}$/);
    assert.ok(isReferralShaped(c));
    assert.ok(isReferralShaped(referralCodeFor("D'Andre-Lee Smithson")));
    assert.ok(isReferralShaped(referralCodeFor('')));
  });
  test('coupon-looking codes are not referral shaped, so the coupon table still gets them', () => {
    for (const c of ['FUEL8', 'FOUNDER25', 'FAMFRIENDS15', 'OWNERS100', 'ZAC-0O1I']) assert.equal(isReferralShaped(c), false, c);
  });
  test('give 2 get 2', () => { assert.equal(REFERRAL_MEALS, 2); });
});

describe('lock ordering (source check)', () => {
  const src = readFileSync(new URL('../functions/api/admin/lock-week.js', import.meta.url), 'utf8');
  test('credits attach after the upcharge and before chargeDraft, on the draft path only', () => {
    const up = src.indexOf('await attachUpchargeToDraft(env, sub, weekOf, order.upchargeCents, draft.id);');
    const cr = src.indexOf('await applyCreditsToDraft(env, sub, weekOf, draft, auditRow)');
    const ch = src.indexOf('({ inv, error } = await chargeDraft(env, draft.id));');
    assert.ok(up > 0 && cr > up && ch > cr, `order was upcharge@${up} credits@${cr} charge@${ch}`);
  });
  test('the referral is credited only after a paid outcome and after the order row is written', () => {
    const commit = src.indexOf("{ order_status: feed.order_status, charge_status: feed.charge_status, invoice_id: invoiceId, charged_at: now }");
    const ref = src.indexOf("if (outcome === 'paid') await creditReferralIfEarned(env, sub.customer_id, sub, weekOf);");
    assert.ok(commit > 0 && ref > commit, `commit@${commit} referral@${ref}`);
  });
  test('the lock row carries size_key so the credit prices at the customer\'s own size', () => {
    assert.match(src, /c\.stripe_customer_id, c\.size_key,/);
  });
});

describe('checkout (source check)', () => {
  const src = readFileSync(new URL('../functions/api/checkout/create.js', import.meta.url), 'utf8');
  test('a referral code attaches NO Stripe coupon (the guarantee must still apply to the first order)', () => {
    const block = src.slice(src.indexOf('referrer = await lookupReferralCode'), src.indexOf('} else if (code) {'));
    assert.ok(!/couponToApply\s*=/.test(block), 'referral branch must not set couponToApply');
  });
  test('the referral row is recorded only after the Checkout Session exists', () => {
    assert.ok(src.indexOf("await stripe(env, 'POST', 'checkout/sessions'") < src.indexOf('await recordReferral(env, referrer, customer.id, code)'));
  });
});
