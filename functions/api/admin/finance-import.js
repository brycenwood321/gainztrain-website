// POST /api/admin/finance-import?mode=preview|commit|undo&account=checking|card&flip=0|1&filename=&force_sign=0|1
// Raw text/csv body (same shape as meal-photo.js: raw body, size ceiling, no multipart). Owner-only.
// preview: parse + detect + dedup against D1, write NOTHING. commit: same parse, rules applied,
// INSERT OR IGNORE in batches, import record + audit row. undo: delete one import's rows.
// GET: last 20 imports. The raw CSV is never stored (the only R2 bucket is served publicly).
import { ok, fail } from '../../_lib/respond.js';
import { requireOwner } from '../../_lib/admin.js';
import { one, all, run, batch, nowIso } from '../../_lib/db.js';
import { randomToken } from '../../_lib/crypto.js';
import { getSessionCustomer } from '../../_lib/auth.js';
import { ACCOUNTS, parseBankCsv, signFlipSuggested, applyRules } from '../../_lib/finance.js';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 5000;
const CSV_TYPES = new Set(['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel', 'application/octet-stream']);

async function existingHashes(db, hashes) {
  const found = new Set();
  for (let i = 0; i < hashes.length; i += 80) {
    const chunk = hashes.slice(i, i + 80);
    const rows = await all(db, `SELECT content_hash FROM bank_transactions WHERE content_hash IN (${chunk.map(() => '?').join(',')})`, ...chunk);
    for (const r of rows) found.add(r.content_hash);
  }
  return found;
}

export async function onRequestGet(context) {
  const denied = await requireOwner(context);
  if (denied) return denied;
  const imports = await all(context.env.DB,
    `SELECT id, account, filename, row_count, inserted_count, duplicate_count, months_json, sign_check_json, created_at
       FROM finance_imports ORDER BY created_at DESC LIMIT 20`);
  return ok({ imports });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const denied = await requireOwner(context);
  if (denied) return denied;
  const u = new URL(request.url);
  const mode = u.searchParams.get('mode') || 'preview';
  const account = u.searchParams.get('account') || '';
  const flip = u.searchParams.get('flip') === '1';
  const forceSign = u.searchParams.get('force_sign') === '1';
  const filename = (u.searchParams.get('filename') || '').slice(0, 120);

  if (mode === 'undo') {
    const importId = u.searchParams.get('import_id') || '';
    if (!importId) return fail(400, 'bad_import', 'import_id required');
    const del = await run(env.DB, `DELETE FROM bank_transactions WHERE import_id = ?`, importId);
    await run(env.DB, `DELETE FROM finance_imports WHERE id = ?`, importId);
    await run(env.DB, `INSERT INTO audit_log (at, actor, entity, action, detail_json) VALUES (?, 'owner', ?, 'finance_import_undo', ?)`,
      nowIso(), `finance_import:${importId}`, JSON.stringify({ deleted: del?.meta?.changes || 0 }));
    return ok({ mode, import_id: importId, deleted: del?.meta?.changes || 0 });
  }

  if (!ACCOUNTS.includes(account)) return fail(400, 'bad_account', 'account must be checking or card');
  const ct = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (ct && !CSV_TYPES.has(ct)) return fail(415, 'bad_type', 'Send the CSV as text/csv.');
  const text = await request.text();
  if (!text || !text.trim()) return fail(400, 'empty', 'No CSV data received.');
  if (text.length > MAX_BYTES) return fail(413, 'too_large', 'CSV is over 2 MB.');

  const parsed = await parseBankCsv(text, { account, flip });
  if (parsed.error === 'empty') return fail(400, 'empty', 'No rows in the CSV.');
  if (parsed.error === 'no_mapping') return fail(422, 'no_mapping', `Could not find date, description and amount columns. Headers seen: ${(parsed.headers || []).join(' | ')}`);
  if (parsed.rows.length > MAX_ROWS) return fail(413, 'too_many_rows', `More than ${MAX_ROWS} rows; split the export.`);

  const hashes = parsed.rows.map((r) => r.content_hash);
  const seen = await existingHashes(env.DB, hashes);
  const fresh = parsed.rows.filter((r) => !seen.has(r.content_hash));
  const dupes = parsed.rows.length - fresh.length;

  // "Check these": groups where the file's count of identical (day, vendor, amount) rows differs from what
  // D1 already holds. File-position occurrence numbering cannot tell an overlapping export from a
  // duplicate, so the owner sees the groups instead of the code deciding silently.
  const groups = new Map();
  for (const r of parsed.rows) groups.set(r.group_key, (groups.get(r.group_key) || 0) + 1);
  const check = [];
  for (const [gkey, n] of groups) {
    const [acct, day, amt, vend] = gkey.split('|');
    const dbn = await one(env.DB, `SELECT COUNT(*) AS n FROM bank_transactions WHERE account = ? AND posted_on = ? AND amount_cents = ? AND dedup_key = ?`, acct, day, Number(amt), vend);
    if ((dbn?.n || 0) > 0 && (dbn?.n || 0) !== n) check.push({ posted_on: day, vendor: vend, amount_cents: Number(amt), in_file: n, in_db: dbn.n });
  }

  const rules = await all(env.DB, `SELECT * FROM finance_rules ORDER BY priority DESC, id ASC`);
  const cats = {}; const months = {};
  for (const r of fresh) {
    const hit = applyRules(rules, r.vendor_norm, r.amount_cents);
    r.category = hit ? hit.category : 'uncategorized'; r.rule_id = hit ? hit.rule_id : null;
    cats[r.category] = (cats[r.category] || 0) + 1;
    const m = months[r.month] = months[r.month] || { rows: 0, in_cents: 0, out_cents: 0 };
    m.rows++; if (r.amount_cents > 0) m.in_cents += r.amount_cents; else m.out_cents += r.amount_cents;
  }
  const outflow = fresh.filter((r) => r.amount_cents < 0).length, inflow = fresh.filter((r) => r.amount_cents > 0).length;
  const signCheck = { outflow_rows: outflow, inflow_rows: inflow, suspicious: fresh.length > 0 && ((account === 'card' && outflow === 0) || (account === 'checking' && inflow === 0 && fresh.length >= 5)), forced: forceSign };

  const base = {
    mode, account, mapping: parsed.mapping, headers: parsed.headers,
    rows_total: parsed.row_count, rows_parsed: parsed.rows.length, skipped: parsed.skipped,
    duplicates: dupes, new: fresh.length, months, would_categorize: cats, check_these: check,
    sign_flip_suggested: signFlipSuggested(parsed.rows, account), sign_check: signCheck,
    sample: fresh.slice(0, 5).map((r) => ({ posted_on: r.posted_on, description_raw: r.description_raw, vendor_norm: r.vendor_norm, amount_cents: r.amount_cents, category: r.category })),
  };
  if (mode === 'preview') return ok(base);
  if (mode !== 'commit') return fail(400, 'bad_mode', 'mode must be preview, commit or undo');
  if (!fresh.length) return ok({ ...base, import_id: null, inserted: 0, note: 'nothing new to import' });
  if (signCheck.suspicious && !forceSign) return fail(422, 'sign_check', `This looks wrong for a ${account} export: ${outflow} money-out rows, ${inflow} money-in rows. Flip the signs or force it.`);

  const now = nowIso();
  const auth = await getSessionCustomer(context).catch(() => null);
  const importId = randomToken(8);
  await run(env.DB,
    `INSERT INTO finance_imports (id, account, filename, mapping_json, row_count, inserted_count, duplicate_count, skipped_json, months_json, sign_check_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    importId, account, filename || null, JSON.stringify(parsed.mapping), parsed.row_count, dupes, JSON.stringify(parsed.skipped), JSON.stringify(months), JSON.stringify(signCheck), auth?.customer?.id || null, now);
  let inserted = 0;
  for (let i = 0; i < fresh.length; i += 40) {
    const stmts = fresh.slice(i, i + 40).map((r) => env.DB.prepare(
      `INSERT OR IGNORE INTO bank_transactions (id, content_hash, import_id, account, posted_on, month, description_raw, vendor_norm, dedup_key, amount_cents, category, category_source, rule_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(randomToken(8), r.content_hash, importId, account, r.posted_on, r.month, r.description_raw, r.vendor_norm, r.dedup_key, r.amount_cents, r.category, r.rule_id ? 'rule' : 'none', r.rule_id, now, now));
    const res = await batch(env.DB, stmts);
    for (const x of res) inserted += x?.meta?.changes || 0;
  }
  await run(env.DB, `UPDATE finance_imports SET inserted_count = ?, duplicate_count = ? WHERE id = ?`, inserted, dupes + (fresh.length - inserted), importId);
  await run(env.DB, `INSERT INTO audit_log (at, actor, entity, action, detail_json) VALUES (?, 'owner', ?, 'finance_import', ?)`,
    now, `finance_import:${importId}`, JSON.stringify({ account, filename, inserted, duplicates: dupes, months }));
  return ok({ ...base, import_id: importId, inserted, categorized: fresh.length - (cats.uncategorized || 0), uncategorized: cats.uncategorized || 0 });
}
