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
