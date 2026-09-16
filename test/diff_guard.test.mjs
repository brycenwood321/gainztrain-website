// diff_guard is a behaviour, not a string: these cases run analyse() against real unified diffs,
// including the two walk-arounds the slice-one review found (a body edit with no token on the line,
// and a rename). Memory two-sides-of-a-check-same-source: a source check that the tokens exist
// proves nothing; this proves the guard fires. Run: npm test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyse } from '../scripts/diff_guard.mjs';

const hdr = (a, b = a) => `diff --git a/${a} b/${b}\n--- a/${a}\n+++ b/${b}\n`;

describe('diff_guard.analyse', () => {
  test('a clean diff elsewhere passes', () => {
    const d = hdr('app/next/index.html') + '@@ -1,0 +2 @@\n+<div>hello</div>\n';
    assert.deepEqual(analyse(d), []);
  });
  test('any hunk in lock-week.js fails even without a token on the line', () => {
    const d = hdr('functions/api/admin/lock-week.js') + '@@ -70 +70 @@\n-      amount: cents,\n+      amount: cents * 2,\n';
    const p = analyse(d);
    assert.equal(p.length, 1); assert.match(p[0], /guarded file changed: functions\/api\/admin\/lock-week.js/);
  });
  test('renaming a guarded file fails', () => {
    const d = 'diff --git a/functions/api/admin/lock-week.js b/functions/api/admin/lock-week2.js\nsimilarity index 98%\nrename from functions/api/admin/lock-week.js\nrename to functions/api/admin/lock-week2.js\n';
    assert.match(analyse(d)[0], /guarded file changed/);
  });
  test('a moved notify( call is a relocation, not a change', () => {
    const d = hdr('functions/api/account/tier.js') + '@@ -40 +40,0 @@\n-  await notify(env, customer, "tier_changed", { meals });\n@@ -55,0 +56 @@\n+    await notify(env, customer, "tier_changed", { meals });\n';
    assert.deepEqual(analyse(d), []);
  });
  test('a notify( call that changed its arguments fails', () => {
    const d = hdr('functions/api/account/tier.js') + '@@ -40 +40 @@\n-  await notify(env, customer, "tier_changed", { meals });\n+  await notify(env, customer, "tier_changed", { meals, silent: true });\n';
    const p = analyse(d);
    assert.equal(p.length, 2);
    assert.ok(p.some((x) => /removed/.test(x)) && p.some((x) => /added/.test(x)));
  });
  test('a comment naming the lock, or a test file, is not a change', () => {
    const d = hdr('functions/_lib/estimate.js') + '@@ -1,0 +2 @@\n+// mirrors what lock-week.js bills\n' + hdr('test/x.test.mjs') + '@@ -1,0 +2 @@\n+const c = cutoffForWeek(w);\n';
    assert.deepEqual(analyse(d), []);
  });
  test('a new cutoffForWeek call site fails (an addition is a change)', () => {
    const d = hdr('functions/api/me.js') + '@@ -10,0 +11 @@\n+const c = cutoffForWeek(week);\n';
    assert.equal(analyse(d).length, 1);
  });
});
