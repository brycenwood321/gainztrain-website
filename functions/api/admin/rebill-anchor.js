// POST /api/admin/rebill-anchor — move every subscription onto ONE weekly billing day: SATURDAY,
// right after the Friday-midnight cutoff + the Saturday 07:30Z lock. Owner-gated. DRY RUN BY DEFAULT.
//
// WHY: billing day was never a decision — it's Stripe's default (the anchor lands wherever checkout
// happened), so customers bill Sun/Mon/Wed/Fri while the FOOD side is already synchronized (lock Friday
// midnight, cook Saturday, deliver Sunday). Aligning money to the food week means:
//   - we know who actually paid BEFORE Jayson shops Saturday morning ("only cook a paid week"),
//   - pause/resume stops depending on where a random anchor fell (the decision parked since June),
//   - specialty upcharges (invoiceitems written by lock-week) land on the very next invoice, not
//     up to 6 days later, after the customer already ate.
//
// THE ONE RULE THAT PREVENTS DOUBLE-BILLING:
//   anchor = the Saturday immediately before the first delivery this subscription has NOT paid for.
// It is NOT a fixed date. Someone already paid through Aug 2 (Josh, Daniel) anchors to Aug 8; someone
// whose last charge covered Jul 26 anchors to Aug 1; someone who signs up during the Saturday ordering
// blackout has already paid for the week 8 days out, so they anchor a week later again. Hardcoding one
// date would double-charge the first group and give the last group a free week.
//
// HOW WE KNOW WHAT A CHARGE PAID FOR: nothing records it, so we derive it — a charge at time T buys the
// week that was orderable at time T, i.e. orderableWeek(T). Verified against all live customers'
// real invoice history before this was written.
//
// MECHANISM: Stripe re-anchors a subscription to `trial_end`, so we set trial_end + proration_behavior
// 'none' (the documented way to change an existing subscription's billing period without issuing a
// prorated invoice). We deliberately do NOT use billing_cycle_anchor=now — that bills immediately.
//
//   curl -X POST https://host/api/admin/rebill-anchor -H "X-Admin-Token: $TOK"            # DRY RUN
//   curl -X POST https://host/api/admin/rebill-anchor -H "X-Admin-Token: $TOK" \
//        -H 'content-type: application/json' -d '{"dry_run":false}'                        # APPLY
import { ok, fail, readJson } from '../../_lib/respond.js';
import { requireOwner } from '../../_lib/admin.js';
import { all, run, nowIso } from '../../_lib/db.js';
import { stripe } from '../../_lib/stripe.js';
import { orderableWeek } from '../../_lib/menu.js';
import { mirrorSubscription } from '../../_lib/mirror.js';

// Saturday 15:00 UTC = 9am MDT / 8am MST. Chosen to sit 7.5h AFTER the lock cron (Sat 07:30 UTC) so the
// specialty-upcharge invoiceitems lock-week writes are always on the books before the invoice renders.
// Stripe anchors are absolute UTC, so the Mountain clock time shifts an hour at DST. Harmless.
const ANCHOR_HOUR_UTC = 15;

// Never move an anchor further out than this. A subscription whose last payment is ancient (long-paused,
// dunning-stalled) would otherwise compute a wild anchor; we skip and report it instead of guessing.
const MAX_DAYS_AHEAD = 21;

function iso(d) { return d.toISOString().slice(0, 10); }

// The Saturday immediately before a given delivery Sunday, at ANCHOR_HOUR_UTC.
function anchorForDelivery(deliverySundayISO) {
  const sunday = new Date(`${deliverySundayISO}T00:00:00Z`);
  const sat = new Date(sunday);
  sat.setUTCDate(sat.getUTCDate() - 1);
  return new Date(Date.UTC(sat.getUTCFullYear(), sat.getUTCMonth(), sat.getUTCDate(), ANCHOR_HOUR_UTC, 0, 0));
}

function addDaysISO(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const denied = await requireOwner(context);
  if (denied) return denied;

  const body = await readJson(request).catch(() => ({}));
  const dryRun = body.dry_run !== false;              // SAFE DEFAULT: must explicitly pass false to mutate
  const only = Array.isArray(body.only) ? new Set(body.only) : null;
  const now = new Date();

  const subs = await all(env.DB,
    `SELECT s.id, s.customer_id, s.stripe_subscription_id, s.status, s.meals_per_week,
            c.first_name, c.last_name, c.email
       FROM subscriptions s JOIN customers c ON c.id = s.customer_id
      WHERE s.stripe_subscription_id IS NOT NULL AND s.status != 'canceled'
      ORDER BY c.first_name`);

  const results = [];

  for (const s of subs) {
    const who = `${s.first_name || '?'} ${s.last_name || ''}`.trim();
    const row = { customer_id: s.customer_id, name: who, email: s.email, sub: s.stripe_subscription_id };
    if (only && !only.has(s.customer_id)) { row.action = 'skipped'; row.reason = 'not_in_only_list'; results.push(row); continue; }

    try {
      // LIVE Stripe is the source of truth, never D1 — the ops list and the customer-detail endpoint
      // currently disagree about who is paused, so trusting the mirror could re-anchor the wrong subs.
      const live = await stripe(env, 'GET', `subscriptions/${s.stripe_subscription_id}`);
      row.stripe_status = live.status;
      row.paused = !!live.pause_collection;

      if (live.status === 'canceled' || live.status === 'incomplete_expired') {
        row.action = 'skipped'; row.reason = `stripe_status_${live.status}`; results.push(row); continue;
      }

      // PAUSED SUBS ARE DELIBERATELY LEFT ALONE. While pause_collection is set no money moves (invoices
      // generate and void), so the anchor is irrelevant until they resume — and resume-time anchoring
      // (in account/resume.js) puts them on Saturday permanently, including for every FUTURE pause.
      // Re-anchoring a paused sub would also mean combining trial_end with pause_collection, which
      // Stripe does not document as supported.
      if (live.pause_collection) {
        row.action = 'skipped'; row.reason = 'paused_will_anchor_on_resume'; results.push(row); continue;
      }

      // What has this subscription actually paid for? Use the last invoice that really collected
      // (status paid). $0 comp invoices count — a comped customer still consumes a delivery slot.
      const invs = await stripe(env, 'GET', 'invoices', {
        subscription: s.stripe_subscription_id, status: 'paid', limit: 1,
      });
      const lastPaid = (invs.data || [])[0];
      if (!lastPaid) { row.action = 'skipped'; row.reason = 'no_paid_invoice_yet'; results.push(row); continue; }

      const paidAt = new Date(lastPaid.created * 1000);
      const coveredWeek = orderableWeek(paidAt);        // the delivery that charge bought
      const nextUnpaid = addDaysISO(coveredWeek, 7);    // the first delivery not yet paid for
      const anchor = anchorForDelivery(nextUnpaid);

      row.last_paid_at = paidAt.toISOString();
      row.last_paid_amount = (lastPaid.amount_paid || 0) / 100;
      row.covers_delivery = coveredWeek;
      row.next_unpaid_delivery = nextUnpaid;
      row.new_anchor = anchor.toISOString();

      // What Stripe plans right now (so the dry run shows exactly which charge is being superseded).
      const itemEnd = live.items?.data?.[0]?.current_period_end || live.current_period_end;
      row.stripe_next_charge = itemEnd ? new Date(itemEnd * 1000).toISOString() : null;

      // ── SAFETY RAILS ──
      const msAhead = anchor.getTime() - now.getTime();
      if (msAhead <= 5 * 60 * 1000) {
        // Anchor already passed (or is imminent) — means this sub is behind on a delivery it should
        // have paid for. Never silently skip a charge; surface it for a human.
        row.action = 'BLOCKED'; row.reason = 'anchor_in_past_check_this_account'; results.push(row); continue;
      }
      if (msAhead > MAX_DAYS_AHEAD * 86400 * 1000) {
        row.action = 'BLOCKED'; row.reason = `anchor_more_than_${MAX_DAYS_AHEAD}d_out`; results.push(row); continue;
      }
      if (itemEnd && anchor.getTime() < itemEnd * 1000) {
        // Moving the anchor EARLIER than Stripe's next charge would bill sooner than the customer
        // expects. Every intended case moves later or stays put; anything else needs eyes on it.
        row.action = 'BLOCKED'; row.reason = 'anchor_earlier_than_current_period_end'; results.push(row); continue;
      }

      if (dryRun) { row.action = 'would_update'; results.push(row); continue; }

      const updated = await stripe(env, 'POST', `subscriptions/${s.stripe_subscription_id}`, {
        trial_end: Math.floor(anchor.getTime() / 1000),
        proration_behavior: 'none',
      }, `gt_rebill_anchor_${s.id}_${iso(anchor)}`);

      await mirrorSubscription(env, updated);
      await run(env.DB,
        `INSERT INTO audit_log (at, actor, entity, action, detail_json) VALUES (?, 'admin:rebill-anchor', ?, 'billing_anchor_moved', ?)`,
        nowIso(), `subscription:${s.id}`,
        JSON.stringify({ from: row.stripe_next_charge, to: row.new_anchor, covers: nextUnpaid }));
      row.action = 'updated';
    } catch (e) {
      row.action = 'ERROR';
      row.reason = String(e?.message || e).slice(0, 200);
    }
    results.push(row);
  }

  const tally = results.reduce((m, r) => { m[r.action] = (m[r.action] || 0) + 1; return m; }, {});
  return ok({ dry_run: dryRun, anchor_hour_utc: ANCHOR_HOUR_UTC, tally, results });
}
