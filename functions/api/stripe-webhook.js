// POST /api/stripe-webhook — the engine that keeps D1 in lockstep with Stripe.
//
// Flow per event:
//   1. Verify the Stripe-Signature header (HMAC-SHA256 of `${t}.${body}` vs whsec). Reject forgeries.
//   2. Idempotency: INSERT the event_id into stripe_events. If it's already there (UNIQUE),
//      we've seen this delivery before — ack 200 and stop. This is why Stripe retries are safe.
//   3. Mirror the object into D1 via _lib/mirror.js (shared with the backfill) + audit_log.
//   4. Always ack 200 on a handled event so Stripe stops retrying; 400 only on a bad signature.
//
// Required env: STRIPE_SECRET_KEY (or GT_STRIPE_TEST_KEY), STRIPE_WEBHOOK_SECRET.

import { run, nowIso } from '../_lib/db.js';
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

export async function onRequestPost(context) {
  const { request, env } = context;
  const rawBody = await request.text();
  const sig = request.headers.get('stripe-signature');

  if (!(await verifySignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET))) {
    return new Response(JSON.stringify({ ok: false, error: 'invalid_signature' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  let event;
  try { event = JSON.parse(rawBody); } catch {
    return new Response(JSON.stringify({ ok: false, error: 'bad_json' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Idempotency gate ──
  try {
    await run(env.DB, `INSERT INTO stripe_events (event_id, type, received_at) VALUES (?, ?, ?)`,
      event.id, event.type, nowIso());
  } catch {
    return new Response(JSON.stringify({ ok: true, duplicate: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  const obj = event.data?.object || {};
  try {
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
        await mirrorPayment(env, obj, 'succeeded');
        break;
      case 'payment_intent.payment_failed':
        await mirrorPayment(env, obj, 'failed');
        break;
      case 'charge.refunded':
        await mirrorPayment(env, { id: obj.payment_intent || obj.id, customer: obj.customer, invoice: obj.invoice, amount: obj.amount_refunded }, 'refunded');
        break;
      default:
        break; // unhandled type — recorded in stripe_events, no mirror action
    }
    await run(env.DB, `UPDATE stripe_events SET processed_at = ? WHERE event_id = ?`, nowIso(), event.id);
  } catch (e) {
    // Leave processed_at NULL so failures are findable/replayable; ack 200 so Stripe
    // doesn't hammer retries on a code bug we need to fix.
    await audit(env, `event:${event.id}`, 'mirror_failed', { type: event.type, error: String(e).slice(0, 300) });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}
