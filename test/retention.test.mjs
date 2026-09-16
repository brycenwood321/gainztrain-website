// The GT retention number's one piece of arithmetic, and the source checks that keep the slice-zero
// guards real. Run: npm test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reminderCutoffIso, PAYING } from '../functions/api/admin/retention.js';

describe('reminderCutoffIso', () => {
  test('is the Wednesday 17:00 UTC before the delivery Sunday', () => {
    assert.equal(reminderCutoffIso('2026-09-20'), '2026-09-16T17:00:00.000Z');
    assert.equal(reminderCutoffIso('2026-09-27'), '2026-09-23T17:00:00.000Z');
  });
  test('crosses a month boundary without drifting', () => {
    assert.equal(reminderCutoffIso('2026-10-04'), '2026-09-30T17:00:00.000Z');
  });
  test('paying means active or trialing, never past_due or paused', () => {
    assert.deepEqual(PAYING, ['active', 'trialing']);
  });
});

describe('slice-zero guards exist (source checks)', () => {
  test('package.json exposes npm run guard and it points at diff_guard', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.match(pkg.scripts.guard || '', /diff_guard\.mjs/);
  });
  test('diff_guard watches the three promised tokens', () => {
    const src = readFileSync(new URL('../scripts/diff_guard.mjs', import.meta.url), 'utf8');
    for (const t of ['lock-week', 'cutoffForWeek', 'notify(']) assert.ok(src.includes(`'${t}'`), `${t} missing`);
  });
});
