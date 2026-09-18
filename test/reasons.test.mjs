// PAUSE / CANCEL REASONS. Run: npm test
//
// Thirteen pauses between 08-26 and 09-13 with no recorded reason cost a hand-texted survey on 09-14.
// The list lives in functions/_lib/reasons.js and is mirrored by the picker in app/manage/index.html,
// which cannot import it. These tests keep the two in step and pin what the server does with a body.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REASONS, DECLINED, readReason, reasonLabel, REASON_TEXT_MAX } from '../functions/_lib/reasons.js';

describe('reason list', () => {
  test('pickup time is its own tap and every code is unique', () => {
    assert.ok(REASONS.some((r) => r.code === 'pickup_time'));
    assert.equal(new Set(REASONS.map((r) => r.code)).size, REASONS.length);
  });
  for (const file of ['../app/manage/index.html', '../app/next/account/index.html']) test(`${file} mirrors the server list exactly, in order`, () => {
    const html = readFileSync(new URL(file, import.meta.url), 'utf8');
    const m = html.match(/const REASONS=\[(.*?)\];/);
    assert.ok(m, 'REASONS array missing from ' + file);
    const page = [...m[1].matchAll(/\['([a-z_]+)','([^']*)'\]/g)].map((x) => ({ code: x[1], label: x[2].replace(/\\'/g, "'") }));
    assert.deepEqual(page, REASONS);
  });
  test('the two endpoints write the reason in the same statement as the state change', () => {
    for (const f of ['pause.js', 'cancel.js']) {
      const src = readFileSync(new URL(`../functions/api/account/${f}`, import.meta.url), 'utf8');
      const stmt = src.match(/UPDATE subscriptions SET (?:status='paused'|cancel_at_period_end=1)[\s\S]*?WHERE id=\?/);
      assert.ok(stmt, `${f}: state-change UPDATE not found`);
      assert.match(stmt[0], /reason_code=\?/, `${f}: reason_code is not in the state-change UPDATE`);
    }
  });
});

describe('readReason', () => {
  test('a picked code and text come through, text capped', () => {
    const r = readReason({ reason: 'pickup_time', reason_text: 'x'.repeat(500) });
    assert.equal(r.code, 'pickup_time');
    assert.equal(r.text.length, REASON_TEXT_MAX);
  });
  test('no body, empty body and undo-only bodies read as declined with no text', () => {
    for (const b of [undefined, null, {}, { undo: true }, { reason: '' }]) {
      assert.deepEqual(readReason(b), { code: DECLINED, text: null });
    }
  });
  test('an unknown code becomes other and keeps the raw code in the text', () => {
    assert.deepEqual(readReason({ reason: 'Moving_Away' }), { code: 'other', text: 'moving_away' });
    assert.deepEqual(readReason({ reason: 'zzz', reason_text: 'moved to Denver' }), { code: 'other', text: 'zzz: moved to Denver' });
  });
  test('labels', () => {
    assert.equal(reasonLabel('pickup_time'), 'The Sunday pickup time');
    assert.equal(reasonLabel(DECLINED), 'declined to say');
    assert.equal(reasonLabel(null), '');
  });
});
