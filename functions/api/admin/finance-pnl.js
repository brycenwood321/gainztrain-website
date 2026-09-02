// GET /api/admin/finance-pnl?months=6 — the month-by-month P&L (owner).
// Revenue: D1 invoices paid (the exact predicate overview.js uses) + negative refund rows in payments.
// Fees: the Stripe month cache. Expenses: bank rows by category. Transfers, owner draws and Stripe payout
// deposits are excluded from everything. THE REFUSE-TO-RENDER RULE (idea_inbox #8): a month carries
// `final: true` and a single profit number ONLY when Stripe is synced + complete with no unknown types,
// nothing is uncategorized, D1 revenue and Stripe gross agree within 1%, the month is closed, and no
// import for the month tripped the sign check. Otherwise it carries a RANGE and the reasons.
import { ok } from '../../_lib/respond.js';
import { requireOwner } from '../../_lib/admin.js';
import { all } from '../../_lib/db.js';
import { EXPENSE_CATEGORIES, EXCLUDED_CATEGORIES, INCOME_CATEGORIES, CATEGORIES, monthRange } from '../../_lib/finance.js';

export async function onRequestGet(context) {
  const denied = await requireOwner(context);
  if (denied) return denied;
  const db = context.env.DB;
  const n = Math.min(24, Math.max(1, parseInt(new URL(context.request.url).searchParams.get('months') || '6', 10) || 6));
  const months = monthRange(n);
  const oldest = months[0];
  const oldestIso = `${oldest}-01T00:00:00.000Z`;
  const cur = new Date().toISOString().slice(0, 7);

  const rev = await all(db, `SELECT substr(created_at,1,7) AS month, COALESCE(SUM(amount_paid_cents),0) AS cents FROM invoices WHERE status = 'paid' AND created_at >= ? GROUP BY 1`, oldestIso);
  const ref = await all(db, `SELECT substr(created_at,1,7) AS month, COALESCE(SUM(amount_cents),0) AS cents FROM payments WHERE status = 'refunded' AND created_at >= ? GROUP BY 1`, oldestIso);
  const bank = await all(db, `SELECT month, category, COUNT(*) AS n, SUM(amount_cents) AS cents, SUM(CASE WHEN amount_cents < 0 THEN amount_cents ELSE 0 END) AS out_cents, SUM(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END) AS in_cents FROM bank_transactions WHERE month >= ? GROUP BY month, category`, oldest);
  const stripeRows = await all(db, `SELECT * FROM finance_stripe_months WHERE month >= ?`, oldest);
  const lastImp = await all(db, `SELECT month, MAX(created_at) AS last_import_at, COUNT(*) AS rows FROM bank_transactions WHERE month >= ? GROUP BY month`, oldest);
  const signTrips = await all(db, `SELECT months_json, sign_check_json FROM finance_imports WHERE created_at >= ?`, oldestIso);

  const byM = (rows, k = 'month') => { const m = {}; for (const r of rows) m[r[k]] = r; return m; };
  const revM = byM(rev), refM = byM(ref), stM = byM(stripeRows), impM = byM(lastImp);
  const bankM = {}; for (const b of bank) (bankM[b.month] = bankM[b.month] || []).push(b);
  const tripped = new Set();
  for (const s of signTrips) { try { const sc = JSON.parse(s.sign_check_json || '{}'); if (sc.suspicious) for (const m of Object.keys(JSON.parse(s.months_json || '{}'))) tripped.add(m); } catch { /* ignore */ } }

  const out = months.map((month) => {
    const revenue_gross = revM[month]?.cents || 0;
    const refunds = refM[month]?.cents || 0;
    const st = stM[month] || null;
    const expenses = {}; let expTotal = 0; let offlineRevenue = 0;
    const excluded = { transfer_cents: 0, owner_draw_cents: 0, stripe_payout_cents: 0 };
    const unc = { count: 0, out_cents: 0, in_cents: 0 };
    for (const c of CATEGORIES) if (EXPENSE_CATEGORIES.includes(c)) expenses[c] = 0;
    for (const b of bankM[month] || []) {
      if (EXPENSE_CATEGORIES.includes(b.category)) { expenses[b.category] = -(b.cents || 0); expTotal += -(b.cents || 0); }
      else if (INCOME_CATEGORIES.includes(b.category)) offlineRevenue += b.cents || 0;
      else if (b.category === 'transfer') excluded.transfer_cents += b.cents || 0;
      else if (b.category === 'owner_draw') excluded.owner_draw_cents += b.cents || 0;
      else if (b.category === 'stripe_payout') excluded.stripe_payout_cents += b.cents || 0;
      else if (b.category === 'uncategorized') { unc.count += b.n || 0; unc.out_cents += b.out_cents || 0; unc.in_cents += b.in_cents || 0; }
    }
    expenses.total_cents = expTotal;
    // Offline revenue (Venmo customers before the app) is real revenue the D1 invoices never saw.
    const revenue_net = revenue_gross + refunds + offlineRevenue;
    let otherTypes = {}; try { otherTypes = st?.other_types_json ? JSON.parse(st.other_types_json) : {}; } catch { otherTypes = {}; }
    const stripeOut = st ? { gross_cents: st.gross_cents, fees_cents: st.fees_cents, refunds_cents: st.refunds_cents, disputes_cents: st.disputes_cents, payouts_cents: st.payouts_cents, payout_count: st.payout_count, other_types: otherTypes, complete: !!st.complete, frozen: !!st.frozen, synced_at: st.synced_at } : null;
    const fees = st ? st.fees_cents : null;
    const delta = st ? revenue_gross - st.gross_cents : null;
    const reconciliation = { d1_cents: revenue_gross, stripe_gross_cents: st ? st.gross_cents : null, delta_cents: delta, delta_pct: st && revenue_gross ? Math.round((delta / revenue_gross) * 10000) / 100 : null };
    const profit = revenue_net - (fees || 0) - expTotal;
    const reasons = [];
    if (month === cur) reasons.push('month still open');
    if (!st) reasons.push('stripe not synced');
    else { if (!st.complete) reasons.push('stripe sync incomplete'); if (Object.keys(otherTypes).length) reasons.push(`stripe unknown types: ${Object.keys(otherTypes).join(', ')}`); }
    if (unc.count) reasons.push(`${unc.count} uncategorized`);
    if (st && revenue_gross && Math.abs(delta) > revenue_gross * 0.01) reasons.push(`D1 vs Stripe revenue differ ${(delta / 100).toFixed(2)}`);
    if (!(impM[month]?.rows)) reasons.push('no bank rows');
    if (tripped.has(month)) reasons.push('an import tripped the sign check');
    const final = reasons.length === 0;
    const bankStripeDeposits = excluded.stripe_payout_cents;
    return {
      month, revenue_gross_cents: revenue_gross, refunds_cents: refunds, offline_revenue_cents: offlineRevenue, revenue_net_cents: revenue_net,
      revenue_reconciliation: reconciliation, stripe: stripeOut, expenses, excluded, uncategorized: unc,
      profit_cents: profit,
      profit_low_cents: profit + unc.out_cents - (delta ? Math.abs(delta) : 0),   // unc.out_cents is negative
      profit_high_cents: profit,
      margin_bp: final && revenue_net > 0 ? Math.round((profit / revenue_net) * 10000) : null,
      payout_delta_cents: st ? bankStripeDeposits - st.payouts_cents : null,
      final, reasons, bank_rows: impM[month]?.rows || 0, last_import_at: impM[month]?.last_import_at || null,
    };
  });
  return ok({ current_month: cur, categories: CATEGORIES, expense_categories: EXPENSE_CATEGORIES, excluded_categories: EXCLUDED_CATEGORIES, months: out });
}
