// Bookkeeping primitives for the ops Finance tab (plan purrfect-humming-dolphin, 2026-09-02).
// Pure functions: header detection for bank CSVs, amount/date parsing, vendor normalisation, the
// content hash that makes re-imports idempotent, and the rule engine. No D1 access here.
import { sha256hex } from './crypto.js';

export const EXPENSE_CATEGORIES = ['food', 'packaging', 'kitchen_rent', 'software', 'advertising', 'delivery', 'fees', 'equipment', 'payroll_contractors', 'customer_refund_offline'];
export const EXCLUDED_CATEGORIES = ['owner_draw', 'transfer', 'stripe_payout'];
export const CATEGORIES = [...EXPENSE_CATEGORIES, ...EXCLUDED_CATEGORIES, 'uncategorized'];
export const ACCOUNTS = ['checking', 'card'];

const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Pick columns by normalised header name. Posted date beats transaction date (it is what a re-export
// will show again). Returns null when date, description or an amount layout cannot be found.
export function detectMapping(headers) {
  const H = headers.map(norm);
  const find = (cands) => { for (const c of cands) { const i = H.indexOf(c); if (i !== -1) return i; } return -1; };
  const date = find(['posteddate', 'postdate', 'postingdate', 'date', 'transactiondate', 'effectivedate', 'datetime']);
  const description = find(['description', 'payee', 'name', 'merchant', 'details', 'transactiondescription', 'originaldescription', 'memodescription']);
  const memo = find(['memo', 'comments', 'notes', 'extendeddescription']);
  const amount = find(['amount', 'transactionamount', 'amt']);
  const debit = find(['debit', 'withdrawal', 'withdrawals', 'amountdebit', 'debitamount', 'moneyout']);
  const credit = find(['credit', 'deposit', 'deposits', 'amountcredit', 'creditamount', 'moneyin']);
  const balance = find(['balance', 'runningbalance', 'endingbalance']);
  const status = find(['status', 'transactionstatus', 'state']);
  const type = find(['type', 'transactiontype', 'category']);
  if (date === -1 || description === -1) return null;
  let layout = null;
  if (amount !== -1) layout = 'signed';
  else if (debit !== -1 && credit !== -1) layout = 'debit_credit';
  else if (debit !== -1 || credit !== -1) layout = 'single_side';
  if (!layout) return null;
  const name = (i) => (i === -1 ? null : headers[i]);
  return { layout, idx: { date, description, memo, amount, debit, credit, balance, status, type },
    date: name(date), description: name(description), memo: name(memo), amount: name(amount), debit: name(debit), credit: name(credit), balance: name(balance), status: name(status), type: name(type) };
}

export function parseAmountCents(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/-$/.test(s)) { neg = true; s = s.slice(0, -1); }
  if (/\bDR\b/i.test(s)) { neg = true; }
  s = s.replace(/\b(CR|DR)\b/gi, '').replace(/[$,\s]/g, '');
  if (s.startsWith('-')) { neg = !neg ? true : neg; s = s.slice(1); }
  if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return neg ? -cents : cents;
}

export function parseDateIso(raw) {
  const s = String(raw == null ? '' : raw).trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/))) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  if ((m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2})$/))) return `20${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

const NOISE = /^(PENDING|POS|PURCHASE|DEBIT|CARD|CHECKCARD|CHECK CARD|ACH|CREDIT|WEB|PPD|CCD|RECURRING|SQ|TST|PAYPAL|VISA|MC|EFT|ELECTRONIC|WITHDRAWAL|DEPOSIT|ONLINE)$/;
export function normalizeVendor(desc) {
  let s = String(desc || '').toUpperCase().replace(/[*#\-_/\\|.,;:'"()]+/g, ' ');
  s = s.replace(/\b\d{1,2}[\/ ]\d{1,2}([\/ ]\d{2,4})?\b/g, ' ');           // dates
  s = s.replace(/\b[A-Z]*\d{3,}[A-Z0-9]*\b/g, ' ');                          // store numbers, auth codes, last-4
  let toks = s.split(/\s+/).filter(Boolean);
  while (toks.length > 1 && NOISE.test(toks[0])) toks.shift();
  toks = toks.filter((t) => !(t.length > 2 && /\d/.test(t) && (t.replace(/\D/g, '').length / t.length) > 0.5));
  const vendor_norm = toks.join(' ').slice(0, 60).trim() || 'UNKNOWN';
  const dedup_key = toks.slice(0, 2).join(' ') || 'UNKNOWN';
  return { vendor_norm, dedup_key };
}

// rules: pre-sorted priority DESC, id ASC. First match wins. Direction-aware.
export function applyRules(rules, vendorNorm, amountCents) {
  const v = String(vendorNorm || '').toUpperCase();
  for (const r of rules) {
    if (r.direction === 'in' && !(amountCents > 0)) continue;
    if (r.direction === 'out' && !(amountCents < 0)) continue;
    let hit = false;
    if (r.match_type === 'regex') { try { hit = new RegExp(r.pattern, 'i').test(v); } catch { hit = false; } }
    else hit = v.includes(String(r.pattern || '').toUpperCase());
    if (hit) return { category: r.category, rule_id: r.id };
  }
  return null;
}

export function monthOf(iso) { return String(iso || '').slice(0, 7); }
export function monthRange(n, now = new Date()) {
  const out = []; const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  for (let i = 0; i < n; i++) { out.unshift(d.toISOString().slice(0, 7)); d.setUTCMonth(d.getUTCMonth() - 1); }
  return out;
}
export function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const gte = Date.UTC(y, m - 1, 1) / 1000; const lt = Date.UTC(y, m, 1) / 1000;
  return { gte, lt, startIso: new Date(gte * 1000).toISOString(), endIso: new Date(lt * 1000).toISOString() };
}

// Parse a whole bank export into normalised rows. `flip` inverts the sign (card exports that print
// charges positive); never applied automatically.
export async function parseBankCsv(text, { account, flip = false, mapping = null } = {}) {
  const { parseCsv } = await import('./csv.js');
  const rows = parseCsv(text);
  if (!rows.length) return { error: 'empty' };
  const headers = rows[0].map((h) => String(h).trim());
  const map = mapping || detectMapping(headers);
  if (!map) return { error: 'no_mapping', headers };
  const out = []; const skipped = { pending: 0, bad_amount: 0, bad_date: 0 };
  const groupSeen = new Map();
  for (const r of rows.slice(1)) {
    const cell = (i) => (i === -1 ? '' : String(r[i] == null ? '' : r[i]).trim());
    const desc0 = cell(map.idx.description); const memo = cell(map.idx.memo);
    const status = cell(map.idx.status);
    if (/pending/i.test(status) || /^PENDING\b/i.test(desc0)) { skipped.pending++; continue; }
    const posted_on = parseDateIso(cell(map.idx.date));
    if (!posted_on) { skipped.bad_date++; continue; }
    let amount;
    if (map.layout === 'signed') amount = parseAmountCents(cell(map.idx.amount));
    else if (map.layout === 'debit_credit') {
      const dr = parseAmountCents(cell(map.idx.debit)); const cr = parseAmountCents(cell(map.idx.credit));
      if (dr == null && cr == null) amount = null;
      else amount = (cr || 0) - Math.abs(dr || 0);
    } else {
      const dr = map.idx.debit !== -1 ? parseAmountCents(cell(map.idx.debit)) : null;
      const cr = map.idx.credit !== -1 ? parseAmountCents(cell(map.idx.credit)) : null;
      amount = dr != null ? -Math.abs(dr) : (cr != null ? Math.abs(cr) : null);
    }
    if (amount == null || amount === 0) { skipped.bad_amount++; continue; }
    if (flip) amount = -amount;
    const description_raw = memo && memo !== desc0 ? `${desc0} | ${memo}` : desc0;
    const { vendor_norm, dedup_key } = normalizeVendor(desc0);
    const gkey = `${account}|${posted_on}|${amount}|${dedup_key}`;
    const occurrence = groupSeen.get(gkey) || 0; groupSeen.set(gkey, occurrence + 1);
    const content_hash = await sha256hex(`${gkey}|${occurrence}`);
    out.push({ posted_on, month: monthOf(posted_on), description_raw: description_raw.slice(0, 300), vendor_norm, dedup_key, amount_cents: amount, content_hash, group_key: gkey, occurrence });
  }
  return { headers, mapping: { ...map, idx: undefined, flip: !!flip }, rows: out, skipped, row_count: rows.length - 1 };
}

export function signFlipSuggested(rows, account) {
  if (account !== 'card' || !rows.length) return false;
  const pos = rows.filter((r) => r.amount_cents > 0).length;
  const negPay = rows.some((r) => r.amount_cents < 0 && /PAYMENT|THANK YOU/.test(r.vendor_norm));
  return pos / rows.length > 0.7 && negPay;
}
