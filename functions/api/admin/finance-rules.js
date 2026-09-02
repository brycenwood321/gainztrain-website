// GET/POST/DELETE /api/admin/finance-rules — the vendor->category rulebook (owner). The list IS the
// evaluation order (priority DESC, id ASC, first match wins). A new rule re-applies to uncategorized rows
// only. Deleting a rule leaves rows categorized (detached to manual) so the P&L never shifts on delete.
import { ok, fail, readJson } from '../../_lib/respond.js';
import { requireOwner } from '../../_lib/admin.js';
import { all, run, nowIso } from '../../_lib/db.js';
import { CATEGORIES } from '../../_lib/finance.js';

export async function onRequestGet(context) {
  const denied = await requireOwner(context);
  if (denied) return denied;
  const rules = await all(context.env.DB,
    `SELECT r.*, (SELECT COUNT(*) FROM bank_transactions b WHERE b.rule_id = r.id) AS hits
       FROM finance_rules r ORDER BY r.priority DESC, r.id ASC`);
  return ok({ rules, categories: CATEGORIES });
}

export async function onRequestPost(context) {
  const { env } = context;
  const denied = await requireOwner(context);
  if (denied) return denied;
  const b = await readJson(context.request);
  const pattern = String(b.pattern || '').trim().slice(0, 200);
  const category = String(b.category || '');
  const matchType = b.match_type === 'regex' ? 'regex' : 'contains';
  const direction = ['in', 'out'].includes(b.direction) ? b.direction : 'any';
  const priority = Math.min(100, Math.max(1, parseInt(b.priority || '50', 10) || 50));
  if (pattern.length < 3) return fail(400, 'bad_pattern', 'Pattern must be at least 3 characters.');
  if (!CATEGORIES.includes(category)) return fail(400, 'bad_category', 'Unknown category.');
  if (matchType === 'regex') { try { new RegExp(pattern, 'i'); } catch { return fail(400, 'bad_regex', 'That regex does not compile.'); } }
  const now = nowIso();
  const ins = await run(env.DB, `INSERT INTO finance_rules (pattern, match_type, direction, category, priority, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    matchType === 'contains' ? pattern.toUpperCase() : pattern, matchType, direction, category, priority, b.note ? String(b.note).slice(0, 200) : null, now);
  const ruleId = ins?.meta?.last_row_id;
  let reapplied = 0;
  if (b.reapply !== false) {
    const dir = direction === 'in' ? 'AND amount_cents > 0' : direction === 'out' ? 'AND amount_cents < 0' : '';
    if (matchType === 'contains') {
      const re = await run(env.DB, `UPDATE bank_transactions SET category = ?, category_source = 'rule', rule_id = ?, updated_at = ? WHERE category = 'uncategorized' AND instr(UPPER(vendor_norm), ?) > 0 ${dir}`,
        category, ruleId, now, pattern.toUpperCase());
      reapplied = re?.meta?.changes || 0;
    } else {
      const cand = await all(env.DB, `SELECT id, vendor_norm FROM bank_transactions WHERE category = 'uncategorized' ${dir}`);
      const rx = new RegExp(pattern, 'i');
      for (const c of cand) if (rx.test(c.vendor_norm)) { await run(env.DB, `UPDATE bank_transactions SET category = ?, category_source = 'rule', rule_id = ?, updated_at = ? WHERE id = ?`, category, ruleId, now, c.id); reapplied++; }
    }
  }
  return ok({ rule: { id: ruleId, pattern, match_type: matchType, direction, category, priority }, reapplied });
}

export async function onRequestDelete(context) {
  const { env } = context;
  const denied = await requireOwner(context);
  if (denied) return denied;
  const id = parseInt(new URL(context.request.url).searchParams.get('id') || '', 10);
  if (!id) return fail(400, 'bad_id', 'id required');
  const det = await run(env.DB, `UPDATE bank_transactions SET rule_id = NULL, category_source = 'manual', updated_at = ? WHERE rule_id = ?`, nowIso(), id);
  await run(env.DB, `DELETE FROM finance_rules WHERE id = ?`, id);
  return ok({ deleted: id, detached: det?.meta?.changes || 0 });
}
