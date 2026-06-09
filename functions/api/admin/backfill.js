// POST /api/admin/backfill — one-shot import of the EXISTING live Stripe state into D1.
// Run once after the remote DB is live so D1 starts already true; the webhook keeps it true after.
// Reuses the exact mirror logic from _lib/mirror.js (no second definition of "Stripe → row").
//
// Auth: header `X-Admin-Token: <ADMIN_TOKEN>` must match env.ADMIN_TOKEN.
// Safe to re-run — every mirror op is upsert/idempotent.
//
//   curl -X POST https://<host>/api/admin/backfill -H "X-Admin-Token: $ADMIN_TOKEN"
//   (add ?dry=1 to count what WOULD import without writing)
import { ok, fail } from '../../_lib/respond.js';
import { requireAdmin } from '../../_lib/admin.js';
import { stripe } from '../../_lib/stripe.js';
import { mirrorSubscription, mirrorInvoice } from '../../_lib/mirror.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const denied = await requireAdmin(context);
  if (denied) return denied;

  const dry = new URL(request.url).searchParams.get('dry') === '1';
  const summary = { subscriptions: 0, invoices: 0, errors: [] };

  // ── Subscriptions (all statuses, paginated) ──
  let startingAfter = null;
  try {
    do {
      const params = { limit: 100, status: 'all', 'expand[]': 'data.discounts.coupon' };
      if (startingAfter) params.starting_after = startingAfter;
      const page = await stripe(env, 'GET', 'subscriptions', params);
      for (const sub of page.data || []) {
        if (!dry) {
          try { await mirrorSubscription(env, sub); }
          catch (e) { summary.errors.push(`sub ${sub.id}: ${String(e).slice(0, 120)}`); }
        }
        summary.subscriptions++;
      }
      startingAfter = page.has_more ? page.data[page.data.length - 1].id : null;
    } while (startingAfter);
  } catch (e) {
    return fail(502, 'stripe_subscriptions_failed', String(e).slice(0, 200));
  }

  // ── Invoices (all, paginated) ──
  startingAfter = null;
  try {
    do {
      const params = { limit: 100 };
      if (startingAfter) params.starting_after = startingAfter;
      const page = await stripe(env, 'GET', 'invoices', params);
      for (const inv of page.data || []) {
        if (!dry) {
          try { await mirrorInvoice(env, inv); }
          catch (e) { summary.errors.push(`inv ${inv.id}: ${String(e).slice(0, 120)}`); }
        }
        summary.invoices++;
      }
      startingAfter = page.has_more ? page.data[page.data.length - 1].id : null;
    } while (startingAfter);
  } catch (e) {
    return fail(502, 'stripe_invoices_failed', String(e).slice(0, 200));
  }

  return ok({ dry, summary });
}
