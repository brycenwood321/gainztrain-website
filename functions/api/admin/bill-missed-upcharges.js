// POST /api/admin/bill-missed-upcharges?week=YYYY-MM-DD[&dry=1][&limit=25]
//
// ONE-TIME CLEANUP, not a routine. When the lock reads a weekly invoice that Stripe already finalized
// (act.action 'settled'), the specialty upcharge cannot be added to it and is logged instead
// (upcharge_missed_settled). This bills those rows as their own invoice: one per customer, charged to
// the card on file, with a memo saying what it is and a line per specialty meal saying which meals.
// Comps are skipped. Idempotent three ways: an audit row per billed customer, Stripe idempotency keys
// on every write, and the invoice's own metadata.
//
// Auth: X-Admin-Token. Always run with dry=1 first and read the plan.
//
//   curl -X POST 'https://gainztrainprep.com/api/admin/bill-missed-upcharges?week=2026-09-20&dry=1' -H "X-Admin-Token: $T"
//   curl -X POST 'https://gainztrainprep.com/api/admin/bill-missed-upcharges?week=2026-09-20'       -H "X-Admin-Token: $T"
import { ok, fail } from '../../_lib/respond.js';
import { requireAdmin } from '../../_lib/admin.js';
import { one, all, run, nowIso } from '../../_lib/db.js';
import { stripe } from '../../_lib/stripe.js';
import { notify } from '../../_lib/notify.js';
import { ownerNotify } from '../../_lib/owner_notify.js';
import { upchargeLines, upchargeMemo, missedUpchargePlan } from '../../_lib/upcharge_bill.js';

async function auditRow(env, entity, action, detail) {
  try {
    await run(env.DB, `INSERT INTO audit_log (at, actor, entity, action, detail_json) VALUES (?, 'admin:bill-missed-upcharges', ?, ?, ?)`,
      nowIso(), entity, action, JSON.stringify(detail).slice(0, 2000));
  } catch { /* never fail a charge on a log row */ }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const denied = await requireAdmin(context);
  if (denied) return denied;
  const url = new URL(request.url);
  const weekOf = url.searchParams.get('week');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekOf || '')) return fail(400, 'bad_week', 'Pass ?week=YYYY-MM-DD (the Sunday delivery).');
  const dry = url.searchParams.get('dry') === '1';
  const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit') || '', 10) || 25));

  // The missed rows for this week, newest per subscription.
  const missed = await all(env.DB,
    `SELECT entity, detail_json, at FROM audit_log WHERE action = 'upcharge_missed_settled' AND detail_json LIKE ? ORDER BY at`,
    `%"weekOf":"${weekOf}"%`);
  const bySub = new Map();
  for (const r of missed) {
    const subId = String(r.entity || '').replace(/^subscription:/, '');
    let d = {}; try { d = JSON.parse(r.detail_json || '{}'); } catch { d = {}; }
    if (subId && d.weekOf === weekOf) bySub.set(subId, { cents: Number(d.cents) || 0, invoiceId: d.invoiceId || null });
  }

  const memo = upchargeMemo(weekOf);
  const s = { week_of: weekOf, dry, found: bySub.size, billed: [], skipped: [], errors: [], total_cents: 0 };
  let handled = 0;
  for (const [subId, m] of bySub) {
    if (handled >= limit) break;
    handled++;
    try {
      const sub = await one(env.DB,
        `SELECT s.id, s.customer_id, c.email, c.first_name, c.stripe_customer_id, c.ghl_contact_id
           FROM subscriptions s JOIN customers c ON c.id = s.customer_id WHERE s.id = ?`, subId);
      if (!sub) { s.skipped.push({ sub: subId, reason: 'no_subscription' }); continue; }
      const who = `${sub.first_name || sub.email} (${sub.email})`;
      const order = await one(env.DB, `SELECT status, charge_status FROM orders WHERE subscription_id = ? AND week_of = ?`, subId, weekOf);
      const alreadyRow = await one(env.DB,
        `SELECT id FROM audit_log WHERE action = 'missed_upcharge_billed' AND entity = ? AND detail_json LIKE ? LIMIT 1`,
        `subscription:${subId}`, `%"weekOf":"${weekOf}"%`);
      const sel = await all(env.DB,
        `SELECT meal_position, meal_name, qty, upcharge_per_meal_cents FROM meal_selections WHERE subscription_id = ? AND week_of = ? ORDER BY meal_position`,
        subId, weekOf);
      const lines = upchargeLines(sel);
      const plan = missedUpchargePlan({ audited: m.cents, order, alreadyRow, lines });
      if (!plan.bill) { s.skipped.push({ who, reason: plan.reason, audited_cents: m.cents }); continue; }
      if (!sub.stripe_customer_id) { s.skipped.push({ who, reason: 'no_stripe_customer', audited_cents: m.cents }); continue; }

      const entry = { who, cents: plan.cents, lines: lines.map((l) => l.description), mismatch: plan.mismatch };
      if (dry) { s.billed.push({ ...entry, invoice: 'DRY RUN' }); s.total_cents += plan.cents; continue; }

      // 1. The invoice shell, with the memo. 2. One line per specialty meal ON that invoice. 3. Finalize,
      //    pay, re-read. auto_advance stays on so a declined card gets Stripe's retries, not silence.
      const inv = await stripe(env, 'POST', 'invoices', {
        customer: sub.stripe_customer_id, collection_method: 'charge_automatically', auto_advance: true,
        description: memo, 'metadata[gt_kind]': 'missed_upcharge', 'metadata[gt_week]': weekOf, 'metadata[gt_subscription]': subId,
      }, `gt_missedup_inv_${subId}_${weekOf}`);
      for (const l of lines) {
        await stripe(env, 'POST', 'invoiceitems', {
          customer: sub.stripe_customer_id, invoice: inv.id, amount: l.cents, currency: 'usd', description: l.description,
        }, `gt_missedup_item_${subId}_${weekOf}_${l.position}`);
      }
      try { await stripe(env, 'POST', `invoices/${inv.id}/finalize`, {}, `gt_missedup_fin_${inv.id}`); } catch (e) { entry.finalize_error = String(e).slice(0, 120); }
      try { await stripe(env, 'POST', `invoices/${inv.id}/pay`, {}, `gt_missedup_pay_${inv.id}`); } catch (e) { entry.pay_error = String(e).slice(0, 120); }
      let after = null; try { after = await stripe(env, 'GET', `invoices/${inv.id}`); } catch { after = null; }
      entry.invoice = inv.id;
      entry.status = after ? after.status : 'unknown';
      entry.amount_paid_cents = after ? after.amount_paid : null;
      entry.url = after ? after.hosted_invoice_url : null;
      await auditRow(env, `subscription:${subId}`, 'missed_upcharge_billed',
        { weekOf, invoiceId: inv.id, cents: plan.cents, status: entry.status, amount_paid_cents: entry.amount_paid_cents, lines: entry.lines, mismatch: plan.mismatch, pay_error: entry.pay_error || null });
      if (entry.status === 'paid') {
        const cust = { id: sub.customer_id, email: sub.email, first_name: sub.first_name, ghl_contact_id: sub.ghl_contact_id };
        try {
          await notify(env, cust, 'upcharge_receipt',
            { amount: plan.cents, weekOf, meals: lines.map((l) => ({ name: l.name, qty: l.qty, cents: l.cents })), invoiceUrl: entry.url },
            { dedupKey: `upcharge_receipt:${subId}:${weekOf}` });
        } catch { /* the Stripe receipt and the audit row still stand */ }
        s.total_cents += plan.cents;
        s.billed.push(entry);
      } else {
        s.errors.push(entry);
      }
    } catch (e) {
      s.errors.push({ sub: subId, error: String(e).slice(0, 200) });
    }
  }

  if (!dry) {
    const lines = [
      ...s.billed.map((b) => `${b.who}: $${(b.cents / 100).toFixed(2)} ${b.status}`),
      ...s.errors.map((b) => `FAILED ${b.who || b.sub}: ${b.pay_error || b.finalize_error || b.error || b.status}`),
      ...s.skipped.map((k) => `skipped ${k.who || k.sub}: ${k.reason}`),
    ];
    try {
      await ownerNotify(env, 'owner_missed_upcharge_billed',
        `Missed upcharges for ${weekOf}: billed ${s.billed.length} customer(s), $${(s.total_cents / 100).toFixed(2)}, ${s.errors.length} failed, ${s.skipped.length} skipped`,
        { entity: `week:${weekOf}`, lines });
    } catch { /* audit rows already hold it */ }
  }
  return ok(s);
}
