// GET  /api/admin/finance-categorize?status=uncategorized|all&month=YYYY-MM&limit=200  (owner)
// POST /api/admin/finance-categorize { id, category, make_rule?, pattern?, note? }
// Rows come back by absolute amount so the ones that move the P&L most get reviewed first. A rule made
// here re-applies to UNCATEGORIZED rows only: a manual or earlier-rule decision is never overwritten.
import { ok, fail, readJson } from '../../_lib/respond.js';
import { requireOwner } from '../../_lib/admin.js';
import { one, all, run, nowIso } from '../../_lib/db.js';
import { CATEGORIES } from '../../_lib/finance.js';

export async function onRequestGet(context) {
  const denied = await requireOwner(context);
  if (denied) return denied;
  const u = new URL(context.request.url);
  const status = u.searchParams.get('status') || 'uncategorized';
  const month = u.searchParams.get('month') || '';
  const limit = Math.min(500, Math.max(1, parseInt(u.searchParams.get('limit') || '200', 10) || 200));
  const where = [];
  const args = [];
  if (status === 'uncategorized') where.push(`category = 'uncategorized'`);
  if (/^\d{4}-\d{2}$/.test(month)) { where.push('month = ?'); args.push(month); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = await all(context.env.DB,
    `SELECT id, account, posted_on, month, description_raw, vendor_norm, amount_cents, category, category_source, rule_id, note
       FROM bank_transactions ${w} ORDER BY ABS(amount_cents) DESC, posted_on DESC LIMIT ${limit}`, ...args);
  const tot = await one(context.env.DB,
    `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN amount_cents < 0 THEN amount_cents ELSE 0 END),0) AS out_cents,
            COALESCE(SUM(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END),0) AS in_cents
       FROM bank_transactions WHERE category = 'uncategorized'` + (args.length ? ' AND month = ?' : ''), ...args);
  return ok({ rows, total_uncategorized: tot?.n || 0, uncategorized_out_cents: tot?.out_cents || 0, uncategorized_in_cents: tot?.in_cents || 0, categories: CATEGORIES });
}

export async function onRequestPost(context) {
  const { env } = context;
  const denied = await requireOwner(context);
  if (denied) return denied;
  const body = await readJson(context.request);
  const id = String(body.id || '');
  const category = String(body.category || '');
  if (!id) return fail(400, 'bad_id', 'id required');
  if (!CATEGORIES.includes(category)) return fail(400, 'bad_category', `category must be one of ${CATEGORIES.join(', ')}`);
  const row = await one(env.DB, `SELECT id, vendor_norm, amount_cents FROM bank_transactions WHERE id = ?`, id);
  if (!row) return fail(404, 'not_found', 'No such transaction.');
  const now = nowIso();
  const note = body.note ? String(body.note).slice(0, 200) : null;
  await run(env.DB, `UPDATE bank_transactions SET category = ?, category_source = 'manual', rule_id = NULL, note = COALESCE(?, note), updated_at = ? WHERE id = ?`, category, note, now, id);
  let rule = null, reapplied = 0;
  if (body.make_rule) {
    const pattern = String(body.pattern || row.vendor_norm || '').trim().toUpperCase().slice(0, 120);
    if (pattern.length < 3) return fail(400, 'bad_pattern', 'Pattern must be at least 3 characters.');
    const direction = row.amount_cents > 0 ? 'in' : 'out';
    const ins = await run(env.DB,
      `INSERT INTO finance_rules (pattern, match_type, direction, category, priority, note, created_at) VALUES (?, 'contains', ?, ?, 50, ?, ?)`,
      pattern, direction, category, `made from "${row.vendor_norm}"`, now);
    const ruleId = ins?.meta?.last_row_id;
    const re = await run(env.DB,
      `UPDATE bank_transactions SET category = ?, category_source = 'rule', rule_id = ?, updated_at = ?
        WHERE (category = 'uncategorized' OR id = ?) AND instr(UPPER(vendor_norm), ?) > 0 AND ${direction === 'in' ? 'amount_cents > 0' : 'amount_cents < 0'}`,
      category, ruleId, now, id, pattern);
    reapplied = Math.max(0, (re?.meta?.changes || 0) - 1);
    rule = { id: ruleId, pattern, category, direction };
  }
  await run(env.DB, `INSERT INTO audit_log (at, actor, entity, action, detail_json) VALUES (?, 'owner', ?, 'finance_categorize', ?)`,
    now, `bank_transaction:${id}`, JSON.stringify({ category, rule, reapplied }));
  return ok({ id, category, rule, reapplied });
}
