// REFERRAL CREDITS RIDE THE LOCK, BEFORE THE CHARGE, CAPPED AT THE WEEK'S MEAL CHARGES. Run: npm test
//
// The referral map (2026-09-14) gave two cautions on a negative invoice item: cap it in code or Stripe
// rolls a negative balance into later weeks, and attach it in the upcharge slot or it lands on next
// week's invoice. The maths is pure and pinned here; the ordering is checked in the source, the same
// way reasons.test.mjs checks that a reason rides the status UPDATE.
//
// Board ruling 2026-09-14 and Brycen's calls 09-15: the friend's reward is FUEL8 (delivered through the
// referral link, which lives in its own checkout field so it can never overwrite FUEL8); the referrer
// gets 4 meals off their next invoice when the friend's first week is paid; no referee credit; no cap.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { creditAmountCents, CREDIT_KINDS } from '../functions/_lib/credits.js';
import { referralCodeFor, isReferralShaped, REFERRAL_MEALS, shareText, referralLink } from '../functions/_lib/referral.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const EM_DASH = String.fromCharCode(8212);

describe('creditAmountCents', () => {
  test('4 meals at $9.50 on a $95.00 draft is $38.00', () => {
    assert.equal(creditAmountCents(4, 950, 9500), 3800);
  });
  test('never more than what is left', () => {
    assert.equal(creditAmountCents(4, 950, 1000), 1000);
    assert.equal(creditAmountCents(4, 950, 0), 0);
    assert.equal(creditAmountCents(4, 950, -5), 0);
  });
  test('garbage in, zero out', () => {
    assert.equal(creditAmountCents(undefined, 950, 8550), 0);
    assert.equal(creditAmountCents(4, null, 8550), 0);
  });
  test('the week-4 bonus is a kind on this path, not a coupon', () => {
    assert.ok(CREDIT_KINDS.week4_bonus);
    assert.ok(CREDIT_KINDS.referral_referrer && CREDIT_KINDS.referral_referred);
  });
  test('the cap is the MEAL charges, not the draft total (delivery fee and upcharge are never credited)', () => {
    const src = read('../functions/_lib/credits.js');
    assert.match(src, /const mealCharges = Math\.max\(0, Math\.round\(perMeal \* \(Number\(sub\.meals_per_week\) \|\| 0\)\)\);/);
    assert.match(src, /let remaining = Math\.min\(Number\(draft\.total\) \|\| 0, mealCharges\);/);
  });
});

describe('referral codes and the reward', () => {
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
  test('the referrer gets 4 meals (Brycen 2026-09-15, over the board chair\'s 2 + 2 staging)', () => {
    assert.equal(REFERRAL_MEALS, 4);
  });
  test('the share text is one sentence with the link, 8 for them and 4 for me', () => {
    const env = { APP_BASE_URL: 'https://example.test' };
    const t = shareText(env, 'ZAC-7K2Q');
    assert.ok(t.includes(referralLink(env, 'ZAC-7K2Q')));
    assert.ok(t.includes('8 free meals') && t.includes('I get 4'));
    assert.ok(!t.includes(EM_DASH), 'no em dash in a customer message');
  });
  test('the friend gets no second credit: creditReferralIfEarned grants the referrer only', () => {
    const src = read('../functions/_lib/referral.js');
    const fn = src.slice(src.indexOf('export async function creditReferralIfEarned'), src.indexOf('export async function referralSummary'));
    assert.equal((fn.match(/await grantCredit\(/g) || []).length, 1, 'exactly one grant');
    assert.ok(!fn.includes("kind: 'referral_referred'"), 'no referee credit');
  });
  test('a referrer with no live subscription is HELD, never voided and never granted onto a dead sub', () => {
    const src = read('../functions/_lib/referral.js');
    const fn = src.slice(src.indexOf('export async function creditReferralIfEarned'), src.indexOf('export async function referralSummary'));
    assert.match(fn, /status IN \('active','trialing','past_due','paused'\) ORDER BY created_at DESC LIMIT 1/);
    assert.ok(fn.includes("'referral_held_referrer_inactive'"), 'audit row when held');
    assert.ok(!fn.includes("void_reason='referrer_has_no_subscription'"), 'no longer voids');
  });
});

describe('lock ordering (source check)', () => {
  const src = read('../functions/api/admin/lock-week.js');
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
  test('a settled invoice writes credit_deferred_settled instead of skipping in silence', () => {
    const start = src.indexOf("if (act.action === 'settled') {");
    const settled = src.slice(start, src.indexOf('} else {', start));
    assert.ok(settled.includes("'credit_deferred_settled'"), 'audit row on the settled path');
    assert.ok(settled.includes('await pendingCredits(env, sub.id)'));
  });
});

describe('checkout (source check): the referral lives beside FUEL8, never instead of it', () => {
  const src = read('../functions/api/checkout/create.js');
  test('the referral is read from its own field, ref, and a referral-shaped promo code still counts', () => {
    assert.match(src, /let refCode = str\(body\.ref\)\.trim\(\)\.toUpperCase\(\);/);
    assert.match(src, /if \(!refCode && isReferralShaped\(code\)\) \{ refCode = code; code = ''; \}/);
  });
  test('a referred friend with no other code gets FUEL8 automatically while the switch is on', () => {
    assert.match(src, /if \(referrer && !code && fuel8Live\) code = 'FUEL8';/);
  });
  test('the referral attaches NO Stripe coupon of its own (the guarantee still applies to a first order without FUEL8)', () => {
    const block = src.slice(src.indexOf('let refCode = str(body.ref)'), src.indexOf('const fuel8Live = await fuel8On(env);'));
    assert.ok(!/couponToApply\s*=/.test(block), 'referral branch must not set couponToApply');
  });
  test('self-referral is refused', () => {
    assert.ok(src.includes("'That is your own referral code.'"));
  });
  test('the referral row is recorded only after the Checkout Session exists', () => {
    assert.ok(src.indexOf("await stripe(env, 'POST', 'checkout/sessions'") < src.indexOf('await recordReferral(env, referrer, customer.id, refCode)'));
  });
  test('the start page sends ref separately and never writes ?ref= into the promo box', () => {
    const page = read('../start/index.html');
    assert.ok(page.includes('<input id="ref" type="hidden" />'), 'hidden ref field');
    assert.ok(page.includes("ref:($('ref').value||'').trim().toUpperCase()"), 'ref in the checkout body');
    const applyRef = page.slice(page.indexOf('function applyRefParam()'), page.indexOf('function restoreCart('));
    assert.ok(!applyRef.includes("$('code').value=ref"), 'ref must not land in the promo box');
    assert.ok(applyRef.includes("$('ref').value=ref"));
  });
});

describe('the ask rides three customer messages (source check)', () => {
  test('menu_posted, order_delivered and order_pickup_ready render referralNote', () => {
    const src = read('../functions/_lib/notify_templates.js');
    for (const key of ['menu_posted:', 'order_delivered:', 'order_pickup_ready:']) {
      const start = src.indexOf(key);
      const block = src.slice(start, start + 1600);
      assert.ok(block.includes('referralNote(d'), `${key} carries the referral note`);
    }
    assert.ok(src.includes('referral_launch:'), 'launch template exists');
  });
  test('every menu blast and delivery notify passes referralData', () => {
    for (const f of ['confirm-menu.js', 'publish-menu.js', 'menu-failsafe.js', 'delivery-status.js']) {
      const src = read(`../functions/api/admin/${f}`);
      assert.ok(src.includes('...(await referralData(env, cust))'), `${f} passes referralData`);
    }
  });
  test('referralNote prints nothing without a code, so an old caller can never print undefined', async () => {
    const { TEMPLATES } = await import('../functions/_lib/notify_templates.js');
    const html = TEMPLATES.order_delivered({ weekOf: '2026-09-20' }, {}).html;
    assert.ok(!html.includes('undefined') && !html.includes('Know someone'));
    const withCode = TEMPLATES.order_delivered({ weekOf: '2026-09-20', referral_code: 'ZAC-7K2Q', referral_link: 'https://x.test/start/?ref=ZAC-7K2Q', referral_meals: 4 }, {}).html;
    assert.ok(withCode.includes('ZAC-7K2Q') && withCode.includes('4 free meals'));
  });
  test('the launch SMS stays inside GSM-7 (no emoji, no curly quotes, no dashes but hyphens)', async () => {
    const { TEMPLATES } = await import('../functions/_lib/notify_templates.js');
    const sms = TEMPLATES.referral_launch({ referral_code: 'ZAC-7K2Q', referral_link: 'https://gainztrainprep.com/start/?ref=ZAC-7K2Q' }, {}).sms;
    assert.ok(/^[\x20-\x7E\n]*$/.test(sms), `non-GSM character in: ${sms}`);
    // GHL appends its own "Reply STOP to unsubscribe." (about 27 chars), so the body budget is ~130.
    assert.ok(sms.length <= 130, `launch SMS is ${sms.length} chars, over one segment once GHL appends STOP`);
  });
});

describe('the referral code table is on the ops dashboard (source check)', () => {
  test('the Marketing tab fetches /api/admin/referrals and renders a row per code holder', () => {
    const ops = read('../app/ops/index.html');
    const fn = ops.slice(ops.indexOf('async function ownRenderMarketing()'), ops.indexOf('async function ownRenderMarketing()') + 12000);
    assert.ok(fn.includes('ownGet("/api/admin/referrals")'), 'fetches the endpoint');
    assert.ok(fn.includes('<h2>Referral codes</h2>'), 'has the card');
    assert.ok(fn.includes('data-copy-link'), 'has a copy button per link');
  });
  test('referralStats exposes customers with code, link and counts', () => {
    const src = read('../functions/api/admin/referrals.js');
    assert.match(src, /friends_signed_up/);
    assert.match(src, /friends_paid/);
    assert.match(src, /customers: customers\.map/);
  });
});

describe('a new customer meets their code in the first receipt (source check)', () => {
  test('order_receipt_first carries referralNote and the webhook passes referralData', async () => {
    const tpl = read('../functions/_lib/notify_templates.js');
    const start = tpl.indexOf('order_receipt_first:');
    assert.ok(tpl.slice(start, start + 1800).includes("referralNote(d, '<br><br>')"), 'receipt carries the note');
    const hook = read('../functions/api/stripe-webhook.js');
    assert.ok(hook.includes("await notify(env, cust, 'order_receipt_first', { ...data, ...(await referralData(env, cust)) }"), 'webhook passes referralData');
    const { TEMPLATES } = await import('../functions/_lib/notify_templates.js');
    const html = TEMPLATES.order_receipt_first({ amount: 9500, firstDelivery: '2026-09-20', referral_code: 'ZAC-7K2Q', referral_link: 'https://x.test/start/?ref=ZAC-7K2Q', referral_meals: 4 }, {}).html;
    assert.ok(html.includes('ZAC-7K2Q') && html.includes('4 free meals'));
    const bare = TEMPLATES.order_receipt_first({ amount: 9500 }, {}).html;
    assert.ok(!bare.includes('undefined') && !bare.includes('Know someone'));
  });
});
