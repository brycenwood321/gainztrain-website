// POST /api/admin/rebill-anchor — bulk-move existing subscriptions onto the Saturday billing day.
// Owner-gated. DRY RUN BY DEFAULT.
//
// This is the BACKFILL tool. Going forward subscriptions land on Saturday by themselves:
//   - new signups  → stripe-webhook.js safeAlignBillingDay() on the first paid invoice
//   - resumes      → account/resume.js
// Both call the same _lib/billing_day.js helper this does, so the rule has exactly one definition.
// Keep this endpoint for backfills, for anything the webhook missed, and as the audit view — the dry
// run is the fastest way to answer "is every customer on the right day, covering the right delivery?"
//
// THE RULE (see _lib/billing_day.js): anchor = the Saturday immediately before the first delivery this
// subscription has NOT paid for. It is NOT a fixed date — hardcoding one double-charges anyone already
// paid ahead and hands a free week to anyone who signed up during the Saturday ordering blackout.
//
//   curl -X POST https://host/api/admin/rebill-anchor -H "X-Admin-Token: $TOK"            # DRY RUN
//   curl -X POST https://host/api/admin/rebill-anchor -H "X-Admin-Token: $TOK" \
//        -H 'content-type: application/json' -d '{"dry_run":false}'                        # APPLY
//
// ⚠️ Cloudflare caps subrequests per Worker invocation — each subscription costs 3-4 Stripe calls, so an
// apply run tops out around a dozen. Batch with "only": [...customer_ids] beyond that; the tally will
// report ERROR rows rather than silently skipping, and the run is safe to repeat.
import { ok, fail, readJson } from '../../_lib/respond.js';
import { requireOwner } from '../../_lib/admin.js';
import { all, run, nowIso } from '../../_lib/db.js';
import { stripe } from '../../_lib/stripe.js';
import { mirrorSubscription } from '../../_lib/mirror.js';
import { anchorAfterPaidCycle, deliveryBoughtBy, moveToBillingDay } from '../../_lib/billing_day.js';

// Only a real billing cycle tells us which delivery a customer bought.
//
// ⚠️ RE-RUN SAFETY: re-anchoring writes an immediate $0 'subscription_update' invoice. Taking simply
// "the newest paid invoice" picks THAT up on a second run, concludes the customer is paid a week
// further ahead than they are, and pushes their anchor out another week — a free delivery. Found by
// re-running the dry run right after the first live migration and seeing four subs drift a week.
// Filter on billing_reason, never on amount: $0 comp renewals are real cycles and must still count.
const CYCLE_REASONS = new Set(['subscription_cycle', 'subscription_create']);

function iso(d) { return d.toISOString().slice(0, 10); }

export async function onRequestPost(context) {
  const { request, env } = context;
  const denied = await requireOwner(context);
  if (denied) return denied;

  const body = await readJson(request).catch(() => ({}));
  const dryRun = body.dry_run !== false;              // SAFE DEFAULT: must explicitly pass false to mutate
  const only = Array.isArray(body.only) ? new Set(body.only) : null;

  // ── MANUAL ANCHOR OVERRIDE ────────────────────────────────────────────────────────────────────
  // The derivation below reads PAID INVOICES. Money that arrives outside the invoice system is
  // therefore invisible to it: a hand-made charge in the Stripe dashboard ("Create payment") is a
  // bare PaymentIntent with no invoice and no billing_reason, so the sub still looks unpaid for that
  // week and gets BLOCKED with its anchor stuck in the past. That is exactly what happened to
  // Jeferson on 2026-08-05 — $119 collected by hand for the Aug 2 week that a paused-collection void
  // had erased.
  //
  // Deliberately narrow, because a wrong anchor applied in bulk is a mass double-charge:
  //   - refuses to run unless `only` names EXACTLY ONE customer
  //   - must still be a Saturday, so the one-billing-day invariant cannot be hand-waved away
  //   - every other guard rail in moveToBillingDay still applies (past, >21d, paused, earlier than
  //     the current period end)
  //   - the audit row records that a human chose this, so it never reads like a derived value
  let override = null;
  if (body.anchor) {
    if (!only || only.size !== 1) {
      return fail(400, 'override_needs_one', 'anchor override requires "only" naming exactly one customer_id.');
    }
    override = new Date(body.anchor);
    if (Number.isNaN(override.getTime())) return fail(400, 'bad_anchor', 'anchor must be an ISO timestamp.');
    if (override.getUTCDay() !== 6) {
      return fail(400, 'anchor_not_saturday', 'anchor must fall on a Saturday — every GT subscription bills Saturday.');
    }
    if (override.getTime() - Date.now() <= 5 * 60 * 1000) {
      return fail(400, 'anchor_in_past', 'anchor must be at least 5 minutes in the future.');
    }
  }

  const subs = await all(env.DB,
    `SELECT s.id, s.customer_id, s.stripe_subscription_id, s.status, s.meals_per_week,
            c.first_name, c.last_name, c.email
       FROM subscriptions s JOIN customers c ON c.id = s.customer_id
      WHERE s.stripe_subscription_id IS NOT NULL AND s.status != 'canceled'
      ORDER BY c.first_name`);

  const results = [];

  for (const s of subs) {
    const row = {
      customer_id: s.customer_id, name: `${s.first_name || '?'} ${s.last_name || ''}`.trim(),
      email: s.email, sub: s.stripe_subscription_id,
    };
    if (only && !only.has(s.customer_id)) { row.action = 'skipped'; row.reason = 'not_in_only_list'; results.push(row); continue; }

    try {
      // LIVE Stripe is the source of truth, never D1 — the ops list and the customer-detail endpoint
      // have been observed disagreeing about who is paused, and acting on a stale mirror would
      // re-anchor the wrong subscriptions.
      const live = await stripe(env, 'GET', `subscriptions/${s.stripe_subscription_id}`);
      row.stripe_status = live.status;
      row.paused = !!live.pause_collection;
      const itemEnd = live.items?.data?.[0]?.current_period_end || live.current_period_end;
      row.stripe_next_charge = itemEnd ? new Date(itemEnd * 1000).toISOString() : null;

      if (live.status === 'canceled' || live.status === 'incomplete_expired') {
        row.action = 'skipped'; row.reason = `stripe_status_${live.status}`; results.push(row); continue;
      }
      // Paused subs bill nothing, so the anchor is moot until they come back — and resume.js now sets
      // it at that moment, which also fixes every FUTURE pause rather than just today's.
      if (live.pause_collection) {
        row.action = 'skipped'; row.reason = 'paused_anchored_on_resume'; results.push(row); continue;
      }

      let anchor;
      if (override) {
        // Derivation skipped on purpose: the paid-invoice history cannot see the payment that
        // justified this override, so consulting it would just re-derive the wrong answer.
        anchor = override;
        row.anchor_source = 'manual_override';
      } else {
        const invs = await stripe(env, 'GET', 'invoices', {
          subscription: s.stripe_subscription_id, status: 'paid', limit: 12,
        });
        const lastPaid = (invs.data || []).find((i) => CYCLE_REASONS.has(i.billing_reason));
        if (!lastPaid) { row.action = 'skipped'; row.reason = 'no_paid_cycle_yet'; results.push(row); continue; }

        const paidAt = new Date(lastPaid.created * 1000);
        anchor = anchorAfterPaidCycle(paidAt, lastPaid.billing_reason);
        row.last_paid_at = paidAt.toISOString();
        row.last_paid_amount = (lastPaid.amount_paid || 0) / 100;
        row.last_paid_reason = lastPaid.billing_reason;
        row.covers_delivery = deliveryBoughtBy(paidAt, lastPaid.billing_reason);
        row.anchor_source = 'derived';
      }
      row.next_unpaid_delivery = iso(new Date(anchor.getTime() + 86400 * 1000)); // the Sunday after the anchor
      row.new_anchor = anchor.toISOString();

      if (dryRun) {
        // Report what an apply WOULD do, using the same guard rails the helper enforces.
        const lead = anchor.getTime() - Date.now();
        if (lead <= 5 * 60 * 1000) row.action = 'BLOCKED', row.reason = 'anchor_in_past_check_this_account';
        else if (itemEnd && Math.abs(anchor.getTime() - itemEnd * 1000) < 60 * 1000) row.action = 'already_correct';
        else if (itemEnd && anchor.getTime() < itemEnd * 1000) row.action = 'BLOCKED', row.reason = 'would_bill_earlier';
        else row.action = 'would_update';
        results.push(row); continue;
      }

      const moved = await moveToBillingDay(env, s.stripe_subscription_id, anchor);
      if (!moved.applied) { row.action = moved.reason === 'already_correct' ? 'already_correct' : 'BLOCKED'; row.reason = moved.reason; results.push(row); continue; }

      await mirrorSubscription(env, moved.updated);
      await run(env.DB,
        `INSERT INTO audit_log (at, actor, entity, action, detail_json) VALUES (?, 'admin:rebill-anchor', ?, 'billing_anchor_moved', ?)`,
        nowIso(), `subscription:${s.id}`,
        JSON.stringify({ from: row.stripe_next_charge, to: row.new_anchor, covers: row.next_unpaid_delivery,
                         source: row.anchor_source, note: body.note || null }));
      row.action = 'updated';
    } catch (e) {
      row.action = 'ERROR';
      row.reason = String(e?.message || e).slice(0, 200);
    }
    results.push(row);
  }

  const tally = results.reduce((m, r) => { m[r.action] = (m[r.action] || 0) + 1; return m; }, {});
  return ok({ dry_run: dryRun, tally, results });
}
