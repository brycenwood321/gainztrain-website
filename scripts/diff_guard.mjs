#!/usr/bin/env node
// diff_guard.mjs: the three things the 2026-09-16 app redesign promised not to change.
//
//   node scripts/diff_guard.mjs                     # staged diff (git diff --cached)
//   node scripts/diff_guard.mjs --working           # working tree against HEAD
//   node scripts/diff_guard.mjs --range a..b
//   node scripts/diff_guard.mjs --working --ack "why this edit to lock-week is intended"
//
// Two rules, both fail loudly (exit 1):
//   FILES: any hunk at all in a guarded file (lock-week.js, menu.js, notify.js), including a rename
//          of one, because a body line without the literal token is still a semantic change
//          (review P1 2026-09-16: `amount: cents * 2` slipped past a token-only check).
//   TOKENS: anywhere else, every removed line naming lock-week, cutoffForWeek or notify( must
//          reappear added with the same text (whitespace ignored) and vice versa: only relocations.
// The only way past a failure is an explicit --ack "<reason>" on the command line, printed with the
// result so it lands in the terminal transcript. No environment variable, nothing a shell profile can
// leave switched on. `npm run guard` runs the working-tree form beside `npm test`.
import { execSync } from 'node:child_process';

export const GUARDED_FILES = ['functions/api/admin/lock-week.js', 'functions/_lib/menu.js', 'functions/_lib/notify.js'];
export const TOKENS = ['lock-week', 'cutoffForWeek', 'notify('];

export function analyse(diff) {
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const problems = [];
  // FILES rule: headers name the file on both sides, so a rename shows up as --- a/old +++ b/new.
  const touched = new Set();
  for (const line of diff.split('\n')) {
    const m = /^(?:\+\+\+|---) [ab]\/(.+)$/.exec(line) || /^(?:rename (?:from|to)) (.+)$/.exec(line);
    if (m && GUARDED_FILES.includes(m[1])) touched.add(m[1]);
  }
  for (const f of touched) problems.push(`guarded file changed: ${f}`);
  // TOKENS rule. Comment lines and the guard's own files (scripts/diff_guard.mjs, test/) are exempt:
  // a comment that NAMES the lock is not a call to it (false positive on the slice-one commit, 2026-09-16).
  const exempt = (f) => /(^|\/)(test\/|scripts\/diff_guard\.mjs)/.test(f);
  const isComment = (body) => /^\s*(\/\/|\*|\/\*|#|<!--)/.test(body);
  let file = '';
  for (const token of TOKENS) {
    const removed = new Map(); const added = new Map();
    for (const line of diff.split('\n')) {
      if (line.startsWith('+++ ') || line.startsWith('--- ')) { if (line.startsWith('+++ ')) file = line.slice(4); continue; }
      if (!line.includes(token)) continue;
      if (exempt(file) || isComment(line.slice(1))) continue;
      if (line.startsWith('+')) { const k = norm(line.slice(1)); added.set(k, (added.get(k) || []).concat(file)); }
      else if (line.startsWith('-')) { const k = norm(line.slice(1)); removed.set(k, (removed.get(k) || []).concat(file)); }
    }
    for (const k of removed.keys()) if (!added.has(k) || added.get(k).length < removed.get(k).length) problems.push(`"${token}" line removed (${removed.get(k)[0]}): ${k.slice(0, 120)}`);
    for (const k of added.keys()) if (!removed.has(k) || removed.get(k).length < added.get(k).length) problems.push(`"${token}" line added (${added.get(k)[0]}): ${k.slice(0, 120)}`);
  }
  return problems;
}

function main() {
  const args = process.argv.slice(2);
  let cmd = 'git diff --cached --unified=0 -M';
  if (args.includes('--working')) cmd = 'git diff HEAD --unified=0 -M';
  const ri = args.indexOf('--range');
  if (ri >= 0 && args[ri + 1]) cmd = `git diff ${args[ri + 1]} --unified=0 -M`;
  const ai = args.indexOf('--ack');
  const ack = ai >= 0 ? (args[ai + 1] || '') : '';

  let diff = '';
  try { diff = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { console.error(`diff_guard: could not run "${cmd}": ${String(e.message).split('\n')[0]}`); process.exit(2); }

  const problems = analyse(diff);
  if (!problems.length) { console.log(`diff_guard: ok (${GUARDED_FILES.length} guarded files untouched; ${TOKENS.join(', ')} only moved or absent in "${cmd}")`); return; }
  console.log('diff_guard: FAIL');
  for (const p of problems) console.log('  ' + p);
  if (ack.trim().length >= 12) { console.log(`\ndiff_guard: acknowledged: "${ack}". Put that sentence in the commit message.`); return; }
  console.log('\nA guarded file or token changed. If that is intended, re-run with --ack "<one sentence why>" and put it in the commit message.');
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
