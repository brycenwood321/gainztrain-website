// POST /api/admin/finance-stripe-sync?months=2&force=0|1 — fill the per-month Stripe cache from
// balance_transactions (keyed by `created`, the month the charge happened, not payout arrival). Owner.
// Unknown transaction types are COUNTED into other_types_json, never dropped: fees understated is profit
// overstated. A month is `complete` only when paging ended (has_more=false) and `frozen` only when
// complete AND the month is closed; ?force=1 re-syncs a frozen month.
import { ok, fail } from '../../_lib/respond.js';
import { requireOwner } from '../../_lib/admin.js';
import { one, run, nowIso } from '../../_lib/db.js';
import { stripe } from '../../_lib/stripe.js';
import { monthRange, monthBounds } from '../../_lib/finance.js';

const MAX_PAGES = 25;

export async function syncStripeMonth(env, month, { force = false } = {}) {
  const cur = new Date().toISOString().slice(0, 7);
  const existing = await one(env.DB, `SELECT frozen FROM finance_stripe_months WHERE month = ?`, month);
  if (existing?.frozen && !force) return { month, skipped: 'frozen' };
  const { gte, lt } = monthBounds(month);
  const agg = { gross: 0, fees: 0, refunds: 0, disputes: 0, payouts: 0, payout_count: 0, txn: 0 };
  const other = {};
  let starting_after = null, complete = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = { created: { gte, lt }, limit: 100 };
    if (starting_after) params.starting_after = starting_after;
    const res = await stripe(env, 'GET', 'balance_transactions', params);
    const data = res?.data || [];
    for (const t of data) {
      agg.txn++;
      const amt = t.amount || 0, fee = t.fee || 0;
      switch (t.type) {
        case 'charge': case 'payment': agg.gross += amt; agg.fees += fee; break;
        case 'refund': case 'payment_refund': agg.refunds += amt; agg.fees += fee; break;
        case 'stripe_fee': case 'application_fee': agg.fees += -amt; break;
        case 'payout': agg.payouts += -amt; agg.payout_count++; break;
        case 'adjustment': case 'dispute': agg.disputes += amt; agg.fees += fee; break;
        default: { const o = other[t.type] = other[t.type] || { n: 0, amount_cents: 0, fee_cents: 0 }; o.n++; o.amount_cents += amt; o.fee_cents += fee; }
      }
      starting_after = t.id;
    }
    if (!res?.has_more) { complete = true; break; }
  }
  const frozen = complete && month < cur ? 1 : 0;
  await run(env.DB,
    `INSERT INTO finance_stripe_months (month, gross_cents, fees_cents, refunds_cents, disputes_cents, payouts_cents, payout_count, txn_count, other_types_json, complete, frozen, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(month) DO UPDATE SET gross_cents=excluded.gross_cents, fees_cents=excluded.fees_cents, refunds_cents=excluded.refunds_cents,
       disputes_cents=excluded.disputes_cents, payouts_cents=excluded.payouts_cents, payout_count=excluded.payout_count, txn_count=excluded.txn_count,
       other_types_json=excluded.other_types_json, complete=excluded.complete, frozen=excluded.frozen, synced_at=excluded.synced_at`,
    month, agg.gross, agg.fees, agg.refunds, agg.disputes, agg.payouts, agg.payout_count, agg.txn, JSON.stringify(other), complete ? 1 : 0, frozen, nowIso());
  return { month, gross_cents: agg.gross, fees_cents: agg.fees, refunds_cents: agg.refunds, disputes_cents: agg.disputes, payouts_cents: agg.payouts, payout_count: agg.payout_count, txn_count: agg.txn, other_types: other, complete, frozen: !!frozen };
}

export async function onRequestPost(context) {
  const { env } = context;
  const denied = await requireOwner(context);
  if (denied) return denied;
  const u = new URL(context.request.url);
  const months = Math.min(12, Math.max(1, parseInt(u.searchParams.get('months') || '2', 10) || 2));
  const force = u.searchParams.get('force') === '1';
  const synced = [], skipped = [];
  try {
    for (const m of monthRange(months)) {
      const r = await syncStripeMonth(env, m, { force });
      if (r.skipped) skipped.push(m); else synced.push(r);
    }
  } catch (e) {
    return fail(502, 'stripe_error', String(e && e.message || e).slice(0, 300));
  }
  return ok({ synced, skipped_frozen: skipped, api_version: env.STRIPE_API_VERSION || null });
}
