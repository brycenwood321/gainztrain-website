// POST /api/admin/lock-week: BILL AT THE LOCK. Runs Saturday 08:00 UTC (pass 1) and 08:30 UTC (pass 2),
// after Stripe has drafted each renewal at the 07:15 anchor (see _lib/billing_day.js).
//
// For every cookable subscription that has no charge outcome for this week yet, IN THIS ORDER:
//   1. cookDecision() on the D1 row: real tier, no unpaid prior invoice, not a post-cutoff signup.
//   2. LIVE Stripe read of the subscription and its draft invoices, then lockAction(): paused or
//      canceled before the lock = skip; period rolled but no draft yet = retry; anchor never moved =
//      legacy path; otherwise charge.
//   3. Compute the order IN MEMORY (their picks if complete, else auto-fill from last week).
//   4. Attach the specialty upcharge TO THIS DRAFT (never as a pending item: once a draft exists a
//      pending item lands on NEXT week's invoice; Stripe docs say so verbatim).
//   5. Finalize, pay, then re-read the invoice. The Stripe wrapper throws on non-2xx, so a declined
//      card arrives as an exception; the re-read is where the truth is.
//   6. ONLY NOW write the order row: status + charge_status + invoice_id + charged_at in one statement.
//   7. Notify the customer only if they are being cooked for.
//   8. Page the owners with counts and names.
//
// Before 2026-09-06 steps 6 and 7 ran first and Stripe billed seven hours later; four weeks of food
// went out with the invoice voided or never created (Jeferson, Luis, Destiny, Stephen). The order of
// the steps above IS the fix. Do not move a write or a notify above the charge.
//
// BATCHED AND RESUMABLE. Each call handles `limit` customers (default 3: about 14 subrequests each,
// and a Pages invocation has been observed dying at ~50) and returns `remaining`. The cron worker
// loops the call until remaining is 0. A customer with a charge_status is never selected again, so
// a run that dies at customer 14 resumes at 15 and nothing is charged twice. Skipped and retried
// customers write no row and are re-read on the next call or pass; that is one GET each and is fine.
//
//   curl -X POST https://host/api/admin/lock-week -H "X-Admin-Token: $ADMIN_TOKEN"
//   ?week_of=YYYY-MM-DD   lock a specific week      ?limit=N   customers per call      ?pass=2   label only
//
// Policies (Brycen's, env-flippable, defaults in _lib/decide.js): LOCK_DECLINED_POLICY=cook|withhold,
// LOCK_QUEUED_CANCEL_POLICY=cook|void.
import { ok, fail } from '../../_lib/respond.js';
import { requireAdmin } from '../../_lib/admin.js';
import { one, all, run, nowIso } from '../../_lib/db.js';
import { upcomingSunday, cutoffForWeek } from '../../_lib/menu.js';
import { repeatLastWeek, evenSpread } from '../../_lib/substitute.js';
import { notify } from '../../_lib/notify.js';
import { ownerNotify } from '../../_lib/owner_notify.js';
import { stripe } from '../../_lib/stripe.js';
import {
  COOKABLE, cookDecision, lockAction, lockPolicies, pickCycleDraft, chargeOutcome, feedAfterCharge,
} from '../../_lib/decide.js';

const DEFAULT_LIMIT = 3;

// Build a [{name, qty}] list (qty>0) from a menu + a Map/array of position→qty, for the email body.
function pickList(menu, qtyByPos) {
  const get = qtyByPos instanceof Map ? (p) => qtyByPos.get(p) || 0 : (p) => qtyByPos[p] || 0;
  return menu.map((m) => ({ name: m.name, qty: get(m.position) })).filter((m) => m.qty > 0);
}

async function auditRow(env, entity, action, detail) {
  try {
    await run(env.DB, `INSERT INTO audit_log (at, actor, entity, action, detail_json) VALUES (?, 'cron:lock-week', ?, ?, ?)`,
      nowIso(), entity, action, JSON.stringify(detail).slice(0, 2000));
  } catch { /* never fail the lock on a log row */ }
}

// LEGACY PATH ONLY (anchor never moved): the week's upcharge as a PENDING invoiceitem, swept into the
// next invoice Stripe creates, exactly as before 2026-09-06. Idempotent per sub+week. Non-fatal.
async function billUpchargePending(env, sub, weekOf, cents) {
  if (!(cents > 0) || !sub.stripe_customer_id) return;
  try {
    await stripe(env, 'POST', 'invoiceitems', {
      customer: sub.stripe_customer_id, amount: cents, currency: 'usd',
      description: `Specialty meal upcharge, week of ${weekOf}`,
    }, `gt_upcharge_${sub.id}_${weekOf}`);
  } catch (e) {
    await auditRow(env, `subscription:${sub.id}`, 'upcharge_bill_failed', { weekOf, cents, error: String(e).slice(0, 160) });
  }
}

// NORMAL PATH: attach the upcharge to THIS cycle's draft. The idempotency key carries the draft id, so
// a re-run against the same draft is a no-op and a re-run against a different draft (a new cycle) is a
// new item, never a rejected key. Non-fatal: an unattached upcharge under-bills by a few dollars and is
// logged; it must not stop the base charge.
async function attachUpchargeToDraft(env, sub, weekOf, cents, draftId) {
  if (!(cents > 0) || !sub.stripe_customer_id || !draftId) return false;
  try {
    await stripe(env, 'POST', 'invoiceitems', {
      customer: sub.stripe_customer_id, invoice: draftId, amount: cents, currency: 'usd',
      description: `Specialty meal upcharge, week of ${weekOf}`,
    }, `gt_upcharge_${sub.id}_${weekOf}_${draftId}`);
    return true;
  } catch (e) {
    await auditRow(env, `subscription:${sub.id}`, 'upcharge_attach_failed', { weekOf, cents, draftId, error: String(e).slice(0, 160) });
    return false;
  }
}

// Finalize and pay, swallowing the throw on each step, then read the invoice back. The read-back is
// the only source of truth used downstream (chargeOutcome).
async function chargeDraft(env, draftId) {
  let error = null;
  try { await stripe(env, 'POST', `invoices/${draftId}/finalize`, {}, `gt_finalize_${draftId}`); }
  catch (e) { error = `finalize: ${String(e?.message || e).slice(0, 120)}`; }
  try { await stripe(env, 'POST', `invoices/${draftId}/pay`, {}, `gt_pay_${draftId}`); }
  catch (e) { error = (error ? error + '; ' : '') + `pay: ${String(e?.message || e).slice(0, 120)}`; }
  let inv = null;
  try { inv = await stripe(env, 'GET', `invoices/${draftId}`); }
  catch (e) { error = (error ? error + '; ' : '') + `read: ${String(e?.message || e).slice(0, 120)}`; }
  return { inv, error };
}

// The order for this customer, computed and NOT written. `picked` = they chose a complete set;
// otherwise repeat last week (closest substitutions) or an even spread.
async function computeOrder(env, sub, weekOf, menu) {
  const picked = await all(env.DB,
    `SELECT meal_position, qty, meal_name FROM meal_selections WHERE subscription_id = ? AND week_of = ? AND qty > 0`,
    sub.id, weekOf);
  const pickedTotal = picked.reduce((s, r) => s + r.qty, 0);
  if (pickedTotal === sub.meals_per_week) {
    const upRow = await one(env.DB,
      `SELECT COALESCE(SUM(qty * upcharge_per_meal_cents), 0) AS up FROM meal_selections WHERE subscription_id = ? AND week_of = ?`,
      sub.id, weekOf);
    return { source: 'picked', total: pickedTotal, upchargeCents: upRow?.up || 0,
      meals: picked.map((p) => ({ name: p.meal_name, qty: p.qty })), qtyByPos: null };
  }
  const prevWeekRow = await one(env.DB,
    `SELECT week_of FROM meal_selections WHERE subscription_id = ? AND qty > 0 AND week_of < ? ORDER BY week_of DESC LIMIT 1`,
    sub.id, weekOf);
  let qtyByPos, source;
  if (prevWeekRow) {
    const prevSel = await all(env.DB,
      `SELECT meal_position, qty FROM meal_selections WHERE subscription_id = ? AND week_of = ? AND qty > 0`,
      sub.id, prevWeekRow.week_of);
    const prevMenuRow = await one(env.DB, `SELECT meals_json FROM weekly_menus WHERE week_of = ?`, prevWeekRow.week_of);
    const prevMenu = prevMenuRow ? JSON.parse(prevMenuRow.meals_json) : [];
    qtyByPos = repeatLastWeek(prevMenu, new Map(prevSel.map((r) => [r.meal_position, r.qty])), menu);
    const t = [...qtyByPos.values()].reduce((a, b) => a + b, 0);
    source = 'repeat_last_week';
    if (t !== sub.meals_per_week) { qtyByPos = evenSpread(menu, sub.meals_per_week); source = 'even_spread'; }
  } else {
    qtyByPos = evenSpread(menu, sub.meals_per_week); source = 'even_spread';
  }
  let total = 0, upchargeCents = 0;
  for (const m of menu) {
    const qty = qtyByPos.get(m.position) || 0;
    total += qty;
    upchargeCents += qty * Math.round((m.upcharge_per_meal || 0) * 100);
  }
  return { source, total, upchargeCents, meals: pickList(menu, qtyByPos), qtyByPos };
}

// THE WRITE. Selections (auto-fill only) and the order row with its charge outcome, in that order.
async function commitOrder(env, sub, weekOf, menu, order, now, charge) {
  if (order.qtyByPos) {
    for (const m of menu) {
      const qty = order.qtyByPos.get(m.position) || 0;
      const upMealCents = Math.round((m.upcharge_per_meal || 0) * 100);
      await run(env.DB,
        `INSERT INTO meal_selections (id, subscription_id, week_of, meal_position, meal_name, qty, upcharge_per_meal_cents, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(subscription_id, week_of, meal_position) DO UPDATE SET
           meal_name=excluded.meal_name, qty=excluded.qty, upcharge_per_meal_cents=excluded.upcharge_per_meal_cents, updated_at=excluded.updated_at`,
        `${sub.id}:${weekOf}:${m.position}`, sub.id, weekOf, m.position, m.name, qty, upMealCents, now, now);
    }
  }
  await run(env.DB,
    `INSERT INTO orders (id, subscription_id, customer_id, week_of, status, total_meals, upcharge_total_cents, delivery_method,
                         locked_at, created_at, updated_at, charge_status, invoice_id, charged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(subscription_id, week_of) DO UPDATE SET
       status=excluded.status, total_meals=excluded.total_meals, upcharge_total_cents=excluded.upcharge_total_cents,
       delivery_method=excluded.delivery_method, locked_at=excluded.locked_at, updated_at=excluded.updated_at,
       charge_status=excluded.charge_status, invoice_id=excluded.invoice_id, charged_at=excluded.charged_at`,
    `${sub.id}:${weekOf}`, sub.id, sub.customer_id, weekOf, charge.order_status, order.total, order.upchargeCents,
    sub.delivery_method || 'pickup', now, now, now, charge.charge_status, charge.invoice_id || null, charge.charged_at || now);
  if (order.source !== 'picked') {
    await auditRow(env, `subscription:${sub.id}`, 'autofilled', { week_of: weekOf, source: order.source });
  }
}

async function notifyLocked(env, cust, sub, weekOf, order) {
  const method = sub.delivery_method || 'pickup';
  if (order.source === 'picked') {
    await notify(env, cust, 'order_locked', { meals: order.meals, total: order.total, weekOf, method },
      { dedupKey: `order_locked:${sub.id}:${weekOf}` });
  } else {
    await notify(env, cust, 'order_autofilled', { meals: order.meals, total: order.total, weekOf, source: order.source, method },
      { dedupKey: `order_autofilled:${sub.id}:${weekOf}` });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const denied = await requireAdmin(context);
  if (denied) return denied;

  const url = new URL(request.url);
  const weekOf = url.searchParams.get('week_of') || upcomingSunday();
  const limit = Math.max(1, Math.min(25, parseInt(url.searchParams.get('limit') || '', 10) || DEFAULT_LIMIT));
  const pass = url.searchParams.get('pass') || '1';
  const policies = lockPolicies(env);

  const menuRow = await one(env.DB, `SELECT meals_json FROM weekly_menus WHERE week_of = ?`, weekOf);
  if (!menuRow) return fail(404, 'no_menu', `No menu published for ${weekOf}.`);
  const menu = JSON.parse(menuRow.meals_json);
  if (!Array.isArray(menu) || menu.length === 0) return fail(422, 'empty_menu', `Menu for ${weekOf} has no meals, fix the menu before locking.`);

  // Cookable subs with NO charge outcome for this week yet. A row with charge_status set is done and
  // is never selected again, which is what makes a re-run safe. Pulls the fields the guards need.
  const subs = await all(env.DB,
    `SELECT s.id, s.customer_id, s.meals_per_week, s.cancel_at_period_end, s.created_at, s.stripe_subscription_id,
            c.email, c.first_name, c.ghl_contact_id, c.delivery_method, c.stripe_customer_id,
            (SELECT COUNT(*) FROM invoices i WHERE i.customer_id = s.customer_id AND i.status = 'open') AS open_invoices
       FROM subscriptions s
       JOIN customers c ON c.id = s.customer_id
       LEFT JOIN orders o ON o.subscription_id = s.id AND o.week_of = ?
      WHERE s.status IN (${COOKABLE.map(() => '?').join(',')}) AND s.origin = 'app'
        AND o.charge_status IS NULL
      ORDER BY s.created_at`,
    weekOf, ...COOKABLE);

  // KNOWN BUG, LEFT AS-IS ON PURPOSE PENDING BRYCEN'S CALL (found 2026-09-05). This is a Date, not an
  // ISO string, so cookDecision's post-cutoff rule never fires. The fix is `.toISOString()`. Applying
  // it changes who gets fed on a live Saturday, so it is a deliberate decision, not a cleanup. Pinned
  // by "post-cutoff guard is dead when handed a Date" in test/charge_and_feed.test.mjs.
  const cutoffISO = cutoffForWeek(weekOf);

  const now = nowIso();
  const batch = subs.slice(0, limit);
  const remaining = Math.max(0, subs.length - batch.length);
  const s = { week_of: weekOf, pass, policies, selected: subs.length, handled: batch.length, remaining,
    paid: [], comp: [], declined_cooked: [], declined_withheld: [], legacy: [], retry: [], voided: [], skipped: [], errors: [] };

  for (const sub of batch) {
    const who = `${sub.first_name || sub.email} (${sub.email})`;
    try {
      const cust = { id: sub.customer_id, email: sub.email, first_name: sub.first_name, ghl_contact_id: sub.ghl_contact_id };

      // 1. Cheap guards on the mirror.
      const decision = cookDecision(sub, cutoffISO);
      if (!decision.cook) { s.skipped.push(decision.message); continue; }

      // 2. LIVE Stripe decides paused / canceled / rolled / draft. Never the mirror.
      let live = null, drafts = [];
      try { live = await stripe(env, 'GET', `subscriptions/${sub.stripe_subscription_id}`); } catch { live = null; }
      if (live) {
        try {
          const r = await stripe(env, 'GET', 'invoices', { subscription: sub.stripe_subscription_id, status: 'draft', limit: 3 });
          drafts = r?.data || [];
        } catch { drafts = []; }
      }
      const draft = pickCycleDraft(drafts, weekOf);
      const act = lockAction({ live, draft, weekOf, policies });

      if (act.action === 'skip') { s.skipped.push(`${who}: ${act.message}`); continue; }
      if (act.action === 'retry') { s.retry.push(`${who}: ${act.message}`); continue; }
      if (act.action === 'void') {
        if (draft) { try { await stripe(env, 'POST', `invoices/${draft.id}/void`, {}, `gt_void_${draft.id}`); } catch { /* Stripe voids it itself later */ } }
        s.voided.push(`${who}: ${act.message}`);
        continue;
      }

      // 3. The order, in memory.
      const order = await computeOrder(env, sub, weekOf, menu);

      if (act.action === 'legacy') {
        // Anchor never moved: old behaviour, flagged. Stripe bills at the old hour; the 13:00/17:00
        // audits still judge it.
        await commitOrder(env, sub, weekOf, menu, order, now,
          { order_status: 'locked', charge_status: 'legacy_anchor', invoice_id: null, charged_at: now });
        await billUpchargePending(env, sub, weekOf, order.upchargeCents);
        try { await notifyLocked(env, cust, sub, weekOf, order); } catch { /* non-fatal */ }
        s.legacy.push(`${who}: ${act.message}`);
        continue;
      }

      // 4. Upcharge onto THIS draft. 5. Finalize, pay, re-read.
      await attachUpchargeToDraft(env, sub, weekOf, order.upchargeCents, draft.id);
      const { inv, error } = await chargeDraft(env, draft.id);
      const outcome = chargeOutcome(inv);
      const feed = feedAfterCharge(outcome, policies);

      if (outcome === 'void') { s.voided.push(`${who}: draft ${draft.id} was voided before the charge (a pause raced the lock), not cooked`); continue; }
      if (!feed.order_status) { s.retry.push(`${who}: charge outcome ${outcome}${error ? ` (${error})` : ''}, will retry`); continue; }

      // 6. Write, with the outcome. 7. Notify only if cooked.
      await commitOrder(env, sub, weekOf, menu, order, now,
        { order_status: feed.order_status, charge_status: feed.charge_status, invoice_id: draft.id, charged_at: now });
      const amt = ((inv?.amount_paid || 0) / 100).toFixed(2);
      if (feed.cook) {
        try { await notifyLocked(env, cust, sub, weekOf, order); } catch { /* non-fatal */ }
        if (outcome === 'paid') s.paid.push(`${who}: $${amt}, ${order.total} meals${act.reason === 'queued_cancel_last_week' ? ', LAST WEEK (cancel queued)' : ''}`);
        else if (outcome === 'comp') s.comp.push(`${who}: comp, ${order.total} meals`);
        else s.declined_cooked.push(`${who}: card DECLINED (${draft.id}), cooked under the cook-and-chase policy${error ? `; ${error}` : ''}`);
      } else {
        s.declined_withheld.push(`${who}: card DECLINED (${draft.id}), NOT cooked under the no-pay-no-food policy`);
      }
    } catch (e) {
      s.errors.push(`${who}: ${String(e).slice(0, 140)}`);
    }
  }

  // 8. Page the owners. Every call writes an audit row; the email goes on the LAST call of a pass
  // (remaining 0) and on any call with errors, so the loop does not spam and a crash still surfaces.
  const counts = Object.fromEntries(['paid', 'comp', 'declined_cooked', 'declined_withheld', 'legacy', 'retry', 'voided', 'skipped', 'errors']
    .map((k) => [k, s[k].length]));
  await auditRow(env, `lock:${weekOf}`, 'lock_pass', { pass, counts, remaining, handled: batch.length });
  if (remaining === 0 || s.errors.length) {
    const week = await all(env.DB,
      `SELECT charge_status, status, COUNT(*) n, SUM(total_meals) meals FROM orders WHERE week_of = ? GROUP BY charge_status, status`, weekOf);
    const totals = week.map((r) => `${r.charge_status || 'none'}/${r.status}: ${r.n} orders, ${r.meals || 0} meals`).join('; ');
    const lines = [];
    for (const k of ['declined_cooked', 'declined_withheld', 'legacy', 'retry', 'voided', 'skipped', 'errors']) {
      for (const line of s[k]) lines.push(`${k}: ${line}`);
    }
    const headline = `Lock ${weekOf} pass ${pass}: this call paid ${counts.paid}, comp ${counts.comp}, declined ${counts.declined_cooked + counts.declined_withheld}, legacy ${counts.legacy}, retry ${counts.retry}, void ${counts.voided}, skipped ${counts.skipped}, errors ${counts.errors}. Week so far: ${totals || 'no orders yet'}.`;
    try { await ownerNotify(env, 'owner_lock_summary', headline, { entity: `lock:${weekOf}`, pass, counts, lines: lines.slice(0, 40) }); } catch { /* non-fatal */ }
  }

  return ok({ summary: s, counts, remaining });
}
