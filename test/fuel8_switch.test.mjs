// FUEL8 HAS NO END DATE. Run: npm test
//
// From 2026-07-15 to 2026-09-15 checkout/create.js and coupons/validate.js each carried a hardcoded
// expiry of 2026-09-01 while the flyers were still out. For two weeks every scan saw the /menu banner
// promise 8 free meals and then "That promo has ended." at checkout. Brycen, 2026-09-14: "it needs to
// still be turned on for anybody that uses that code." The switch is the ops_kv key promo_flags
// (plans.js fuel8On); a missing or unreadable key means ON.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fuel8On } from '../functions/_lib/plans.js';

// A tiny D1 stand-in: prepare(sql).bind(...).first() as _lib/db.js one() uses it.
function dbWith(valueJson, { throws = false } = {}) {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => { if (throws) throw new Error('D1 down'); return valueJson === undefined ? null : { value_json: valueJson }; },
        all: async () => ({ results: [] }),
        run: async () => ({}),
      }),
    }),
  };
}

describe('fuel8On', () => {
  test('no promo_flags row means ON (a fresh database can never turn the flyers off)', async () => {
    assert.equal(await fuel8On({ DB: dbWith(undefined) }), true);
  });
  test('fuel8_on:false means OFF', async () => {
    assert.equal(await fuel8On({ DB: dbWith(JSON.stringify({ fuel8_on: false })) }), false);
  });
  test('fuel8_on:true means ON', async () => {
    assert.equal(await fuel8On({ DB: dbWith(JSON.stringify({ fuel8_on: true })) }), true);
  });
  test('a row without the key, garbage JSON, or a failed read all mean ON', async () => {
    assert.equal(await fuel8On({ DB: dbWith(JSON.stringify({ other: 1 })) }), true);
    assert.equal(await fuel8On({ DB: dbWith('not json') }), true);
    assert.equal(await fuel8On({ DB: dbWith(undefined, { throws: true }) }), true);
  });
});

describe('no promo end date is hardcoded anywhere (source check)', () => {
  const files = ['../functions/api/checkout/create.js', '../functions/api/coupons/validate.js', '../functions/_lib/plans.js'];
  for (const f of files) {
    test(`${f} carries no 2026-09-01 expiry and no Date.parse gate on FUEL8`, () => {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      assert.ok(!src.includes('2026-09-01'), `${f} still names the old end date`);
      assert.ok(!/FUEL8_ENDS/.test(src), `${f} still references FUEL8_ENDS`);
    });
  }
  test('checkout and the validator both ask the switch', () => {
    const create = readFileSync(new URL('../functions/api/checkout/create.js', import.meta.url), 'utf8');
    const validate = readFileSync(new URL('../functions/api/coupons/validate.js', import.meta.url), 'utf8');
    assert.match(create, /await fuel8On\(env\)/);
    assert.match(validate, /await fuel8On\(env\)/);
  });
  test('promo_flags is whitelisted in ops-store and owner-only to write', () => {
    const src = readFileSync(new URL('../functions/api/admin/ops-store.js', import.meta.url), 'utf8');
    assert.match(src, /const ALLOWED = new Set\(\[[^\]]*'promo_flags'/);
    assert.match(src, /const OWNER_WRITE = new Set\(\[[^\]]*'promo_flags'/);
  });
  test('the /menu banner asks the validator before it keeps its promise', () => {
    const src = readFileSync(new URL('../menu/index.html', import.meta.url), 'utf8');
    assert.ok(src.includes("/api/coupons/validate?code=' + encodeURIComponent(promo)"), 'banner must validate the promo');
    assert.ok(src.includes('That offer has ended'), 'banner must have an ended wording');
  });
});
