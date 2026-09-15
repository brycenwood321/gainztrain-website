// Keep the static marketing pages in step with functions/_lib/pickup.js.
//
//   node scripts/pickup_window.mjs            print the window in force and what each page says
//   node scripts/pickup_window.mjs --check    exit 1 if any page disagrees with the config (npm test runs this)
//   node scripts/pickup_window.mjs --render   rewrite every <span data-pickup="window|length"> from the config
//   --sunday YYYY-MM-DD                       render/check for that Sunday instead of the upcoming one
//
// Why a script and not a fetch: the five pages are static HTML read by crawlers, ad landings and people
// with JS off, so the window has to be IN the file. The spans are the contract; grep for data-pickup.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pickupFor, upcomingSundayISO } from '../functions/_lib/pickup.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PAGES = ['contact.html', 'subscribe/index.html', 'faqs/index.html', 'delivery/index.html'];
const SPAN = /(<span data-pickup="(window|length)">)([^<]*)(<\/span>)/g;

function htmlFor(p, kind) {
  return kind === 'window' ? p.windowLabel.replace('–', '&ndash;') : p.lengthLabel;
}

// Every marker on every page, with what it says and what it should say. Empty `wrong` means in step.
export function checkPages(sunday = upcomingSundayISO(), root = ROOT) {
  const p = pickupFor(sunday);
  const found = [];
  const wrong = [];
  for (const rel of PAGES) {
    const html = readFileSync(join(root, rel), 'utf8');
    let n = 0;
    for (const m of html.matchAll(SPAN)) {
      n++;
      const want = htmlFor(p, m[2]);
      found.push({ page: rel, kind: m[2], text: m[3] });
      if (m[3] !== want) wrong.push({ page: rel, kind: m[2], has: m[3], want });
    }
    if (n === 0) wrong.push({ page: rel, kind: 'marker', has: 'none', want: 'at least one data-pickup span' });
  }
  return { sunday, window: p.windowLabel, found, wrong };
}

export function renderPages(sunday = upcomingSundayISO(), root = ROOT) {
  const p = pickupFor(sunday);
  const changed = [];
  for (const rel of PAGES) {
    const path = join(root, rel);
    const before = readFileSync(path, 'utf8');
    const after = before.replace(SPAN, (_m, open, kind, _old, close) => open + htmlFor(p, kind) + close);
    if (after !== before) { writeFileSync(path, after); changed.push(rel); }
  }
  return { sunday, window: p.windowLabel, changed };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const si = args.indexOf('--sunday');
  const sunday = si >= 0 ? args[si + 1] : upcomingSundayISO();
  if (args.includes('--render')) {
    const r = renderPages(sunday);
    console.log(`rendered ${r.window} for Sunday ${r.sunday}; changed: ${r.changed.length ? r.changed.join(', ') : 'nothing'}`);
  }
  const c = checkPages(sunday);
  console.log(`config: ${c.window} for Sunday ${c.sunday}`);
  for (const f of c.found) console.log(`  ${f.page} [${f.kind}] ${f.text}`);
  if (c.wrong.length) {
    console.log('OUT OF STEP:');
    for (const w of c.wrong) console.log(`  ${w.page} [${w.kind}] has "${w.has}" want "${w.want}"`);
    if (args.includes('--check')) process.exit(1);
  } else {
    console.log('all pages in step');
  }
}
