// POST /api/stripe-webhook — the engine that keeps D1 in lockstep with Stripe.
//
// Flow per event:
//   1. Verify the Stripe-Signature header (HMAC-SHA256 of `${t}.${body}` vs whsec). Reject forgeries.
//   2. Idempotency-as-a-LOCK (not a tombstone): INSERT the event into stripe_events. If it's
//      already there AND processed_at is set, it's a true duplicate → ack 200. If it's there but
//      processed_at is NULL, a prior attempt failed/was in-flight → reprocess (safe: every mirror
//      op is an idempotent upsert).
//   3. Mirror the object into D1 via _lib/mirror.js (shared with the backfill) + audit_log.
//   4. On success → stamp processed_at, ack 200. On FAILURE → delete the lock row + return 500 so
//      Stripe retries with backoff. This gives at-least-once processing; nothing is silently lost.
//
// Required env: STRIPE_SECRET_KEY (or GT_STRIPE_TEST_KEY), STRIPE_WEBHOOK_SECRET.

import { one, run, nowIso } from '../_lib/db.js';
import { hmacSign, constantTimeEqual } from '../_lib/crypto.js';
import { ensureCustomer, mirrorSubscription, mirrorInvoice, mirrorPayment, audit } from '../_lib/mirror.js';
import { notify } from '../_lib/notify.js';
import { ownerNotify } from '../_lib/owner_notify.js';

const SIG_TOLERANCE_SECONDS = 300; // reject events whose timestamp is >5 min skewed

async function verifySignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = Object.fromEntries(
    sigHeader.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  const skew = Math.abs(Math.floor(Date.now() / 1000) - parseInt(t, 10));
  if (!Number.isFinite(skew) || skew > SIG_TOLERANCE_SECONDS) return false;
  const expected = await hmacSign(secret, `${t}.${rawBody}`);
  return constantTimeEqual(expected, v1);
}

const reply = (status, obj) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json' },
});

async function dispatch(env, event) {
  const obj = event.data?.object || {};
  switch (event.type) {
    case 'customer.created':
    case 'customer.updated':
      await ensureCustomer(env, obj.id);
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await mirrorSubscription(env, obj);
      break;
    case 'invoice.created':
    case 'invoice.finalized':
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
    case 'invoice.payment_failed':
    case 'invoice.voided':
      await mirrorInvoice(env, obj);
      break;
    case 'payment_intent.succeeded':
      await mirrorPayment(env, { id: obj.id, invoice: obj.invoice, customer: obj.customer, amount: obj.amount_received ?? obj.amount, status: 'succeeded' });
      break;
    case 'payment_intent.payment_failed':
      await mirrorPayment(env, { id: obj.id, invoice: obj.invoice, customer: obj.customer, amount: obj.amount, status: 'failed' });
      break;
    case 'charge.refunded':
      // Refund is its OWN row (distinct id + negative amount) so the original charge survives.
      await mirrorPayment(env, { id: `${obj.id}_refund`, invoice: obj.invoice, customer: obj.customer, amount: -(obj.amount_refunded || 0), status: 'refunded' });
      break;
    default:
      break; // unhandled type — recorded in stripe_events, no mirror action
  }
  // Customer-facing billing notifications fire AFTER the mirror, off the webhook (the reliable,
  // idempotent truth). Fully self-contained + try/caught: a comms failure must NEVER fail the
  // webhook, or Stripe would retry and re-mirror. Dedup keys are natural Stripe ids so the
  // invoice.paid / invoice.payment_succeeded twin events + retries all collapse to one send.
  await safeNotifyBilling(env, event);
  // OWNER alerts (signup / payment failed / refund). NOT gated by BILLING_NOTIFY_ENABLED — that gate is
  // for customer emails during cutover; the owners want to know about money events regardless.
  await safeNotifyOwner(env, event);
}

async function safeNotifyOwner(env, event) {
  try {
    const obj = event.data?.object || {};
    switch (event.type) {
      case 'customer.subscription.created': {
        const cust = await ensureCustomer(env, obj.customer);
        const meals = (obj.metadata && obj.metadata.meals_per_week) || '?';
        const who = cust ? (cust.first_name || cust.email) : (obj.customer || 'someone');
        await ownerNotify(env, 'owner_new_signup', `New signup: ${who} — ${meals} meals/wk 🎉`,
          { entity: cust ? `customer:${cust.id}` : 'system' });
        break;
      }
      case 'invoice.payment_failed': {
        const cust = await ensureCustomer(env, obj.customer);
        const who = cust ? (cust.first_name || cust.email) : (obj.customer || 'someone');
        const amt = ((obj.amount_due ?? obj.amount_remaining ?? 0) / 100).toFixed(2);
        await ownerNotify(env, 'owner_payment_failed', `⚠️ Payment failed: ${who} — $${amt} (attempt ${obj.attempt_count || 1})`,
          { entity: cust ? `customer:${cust.id}` : 'system' });
        break;
      }
      case 'charge.refunded': {
        const latest = obj.refunds && obj.refunds.data && obj.refunds.data[0];
        const amount = latest ? latest.amount : (obj.amount_refunded || 0);
        if (amount <= 0) break;
        const cust = await ensureCustomer(env, obj.customer);
        const who = cust ? (cust.first_name || cust.email) : (obj.customer || 'someone');
        await ownerNotify(env, 'owner_refund', `Refund issued: ${who} — $${(amount / 100).toFixed(2)}`,
          { entity: cust ? `customer:${cust.id}` : 'system' });
        break;
      }
      default:
        break;
    }
  } catch { /* owner alerts must never fail the webhook */ }
}

async function safeNotifyBilling(env, event) {
  try {
    // CUTOVER GATE: existing customers are still on the OLD GHL funnel. Until we deliberately cut over,
    // do NOT auto-email them billing notifications from the webhook (would duplicate old GHL emails +
    // link them to /app they've never used). Unset/false = off; flip BILLING_NOTIFY_ENABLED=true at cutover.
    if (String(env.BILLING_NOTIFY_ENABLED) !== 'true') return;
    const obj = event.data?.object || {};
    switch (event.type) {
      case 'invoice.paid': {
        const amount = obj.amount_paid ?? 0;
        if (amount <= 0) return; // comp / $0 (OWNERS100) — suppress the confusing "charged $0" receipt
        const reason = obj.billing_reason;
        if (reason !== 'subscription_create' && reason !== 'subscription_cycle') return;
        const cust = await ensureCustomer(env, obj.customer);
        if (!cust) return;
        const discount = (obj.total_discount_amounts || []).reduce((s, d) => s + (d.amount || 0), 0);
        const data = { amount, discount, invoiceUrl: obj.hosted_invoice_url || null };
        // Fire only on invoice.paid (NOT the payment_succeeded twin) and key on the invoice id.
        if (reason === 'subscription_create') {
          await notify(env, cust, 'order_receipt_first', data, { dedupKey: `receipt_first:${obj.id}` });
        } else if ((obj.attempt_count || 0) > 1) {
          // A renewal that succeeded after one or more failed attempts → recovery, not a plain receipt.
          await notify(env, cust, 'payment_recovered', data, { dedupKey: `recovered:${obj.id}` });
        } else {
          await notify(env, cust, 'renewal_receipt', data, { dedupKey: `receipt_cycle:${obj.id}` });
        }
        break;
      }
      case 'invoice.payment_failed': {
        // EVERY decline is the soft "update your card" nudge (keyed per attempt so each retry notifies
        // once). We do NOT infer "dunning exhausted" from a missing next_payment_attempt — under Stripe
        // Smart Retries (the default) that field isn't on this event, which would fire the "paused"
        // email on the very first decline. The FINAL/"paused" email is driven off the subscription
        // actually going unpaid (customer.subscription.updated below).
        const cust = await ensureCustomer(env, obj.customer);
        if (!cust) return;
        const data = { amount: obj.amount_due ?? obj.amount_remaining ?? 0, invoiceUrl: obj.hosted_invoice_url || null };
        await notify(env, cust, 'payment_failed', data, { dedupKey: `pf:${obj.id}:${obj.attempt_count || 0}` });
        break;
      }
      case 'customer.subscription.updated': {
        // Dunning truly exhausted → Stripe flips the subscription to 'unpaid'. THIS is the deterministic
        // signal for the "your plan is paused" email (keyed per billing period so a later cycle can re-fire).
        if (obj.status !== 'unpaid') return;
        const cust = await ensureCustomer(env, obj.customer);
        if (!cust) return;
        await notify(env, cust, 'payment_failed_final', { invoiceUrl: null },
          { dedupKey: `unpaid:${obj.id}:${obj.current_period_end || ''}` });
        break;
      }
      case 'charge.refunded': {
        // obj.amount_refunded is CUMULATIVE across all refunds on the charge — never show it as "your
        // refund". Use the triggering refund object (most recent first) for the amount + its id as the
        // natural idempotency key, so a 2nd partial refund emails the right amount and notifies once.
        const latest = obj.refunds && obj.refunds.data && obj.refunds.data[0];
        const amount = latest ? latest.amount : (obj.amount_refunded || 0);
        if (amount <= 0) return;
        const cust = await ensureCustomer(env, obj.customer);
        if (!cust) return;
        await notify(env, cust, 'refund_issued',
          { amount, partial: (obj.amount_refunded || 0) < (obj.amount || amount) },
          { dedupKey: `refund:${latest ? latest.id : obj.id}` });
        break;
      }
      case 'customer.subscription.deleted': {
        const cust = await ensureCustomer(env, obj.customer);
        if (!cust) return;
        await notify(env, cust, 'subscription_ended', {}, { dedupKey: `subend:${obj.id}` });
        break;
      }
      // ── Step 3 events: must ALSO be subscribed in the Stripe dashboard webhook config to ever fire.
      // Neither is in the mirror switch above (no D1 object to mirror), so they reach here cleanly.
      case 'invoice.upcoming': {
        // Pre-renewal heads-up. invoice.upcoming has NO invoice id, so dedup on subscription + period.
        const amount = obj.amount_due ?? obj.total ?? 0;
        if (amount <= 0) return; // comp plan — no charge coming, no heads-up
        const cust = await ensureCustomer(env, obj.customer);
        if (!cust) return;
        const when = obj.next_payment_attempt
          ? new Date(obj.next_payment_attempt * 1000).toISOString()
          : (obj.period_end ? new Date(obj.period_end * 1000).toISOString() : null);
        await notify(env, cust, 'renewal_upcoming', { amount, when }, { dedupKey: `upcoming:${obj.subscription}:${obj.period_end || ''}` });
        break;
      }
      case 'customer.source.expiring': {
        const cust = await ensureCustomer(env, obj.customer);
        if (!cust) return;
        await notify(env, cust, 'card_expiring',
          { last4: obj.last4, month: obj.exp_month, year: obj.exp_year },
          { dedupKey: `cardexp:${obj.id}:${obj.exp_month}-${obj.exp_year}` });
        break;
      }
      default:
        break;
    }
  } catch { /* notifications must never fail the webhook */ }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const rawBody = await request.text();
  const sig = request.headers.get('stripe-signature');

  if (!(await verifySignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET))) {
    return reply(400, { ok: false, error: 'invalid_signature' });
  }

  let event;
  try { event = JSON.parse(rawBody); } catch { return reply(400, { ok: false, error: 'bad_json' }); }
  if (!event.id || !event.type) return reply(400, { ok: false, error: 'malformed_event' });

  // ── Idempotency-as-a-lock ──
  let inserted = true;
  try {
    await run(env.DB, `INSERT INTO stripe_events (event_id, type, received_at) VALUES (?, ?, ?)`,
      event.id, event.type, nowIso());
  } catch {
    inserted = false;
  }
  if (!inserted) {
    const prior = await one(env.DB, `SELECT processed_at FROM stripe_events WHERE event_id = ?`, event.id);
    if (prior && prior.processed_at) return reply(200, { ok: true, duplicate: true });
    // else: prior attempt failed or is in-flight → fall through and (re)process (mirrors are idempotent)
  }

  try {
    await dispatch(env, event);
    await run(env.DB, `UPDATE stripe_events SET processed_at = ? WHERE event_id = ?`, nowIso(), event.id);
    return reply(200, { ok: true });
  } catch (e) {
    // Release the lock so Stripe's retry can reprocess, and signal failure so it DOES retry.
    await audit(env, `event:${event.id}`, 'mirror_failed', { type: event.type, error: String(e).slice(0, 300) });
    try { await run(env.DB, `DELETE FROM stripe_events WHERE event_id = ? AND processed_at IS NULL`, event.id); } catch { /* best effort */ }
    return reply(500, { ok: false, error: 'mirror_failed' });
  }
}
