// POST /api/admin/enrich-ghl — one-time backfill enrichment for customers whose subs
// predate the D1 system. GT stores the meal tier in a GHL custom field (subscription_meals),
// not in Stripe, so the Stripe backfill can't see it. This matches each D1 customer to their
// GHL contact by email and fills: customers.ghl_contact_id, subscriptions.meals_per_week,
// and subscriptions.coupon_code (from the contact's coupon field if present).
//
// NOT the ongoing mechanism — new signups should write meals→D1 at checkout. This is cleanup
// for the legacy rows only. Re-runnable (idempotent). Auth: X-Admin-Token = env.ADMIN_TOKEN.
import { ok, fail } from '../../_lib/respond.js';
import { requireAdmin } from '../../_lib/admin.js';
import { all, one, run, nowIso } from '../../_lib/db.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const CF_SUBSCRIPTION_MEALS = 'xsIiGkYsROz2cwRiNxvZ'; // GHL custom field id holding meals/week
const CF_MEALS_PER_WEEK_LEGACY = 'yUT9K2GPlmHxhodOFUjq';

async function findGhlContactByEmail(env, email) {
  const url = `${GHL_BASE}/contacts/?locationId=${env.GAINZ_GHL_LOCATION}&query=${encodeURIComponent(email)}&limit=5`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${env.GAINZ_GHL_TOKEN}`, Version: '2021-07-28' },
  });
  if (!r.ok) return null;
  const contacts = (await r.json()).contacts || [];
  // Exact email match wins (query is fuzzy).
  return contacts.find((c) => (c.email || '').toLowerCase() === email.toLowerCase()) || null;
}

function readCustomField(contact, id) {
  const cf = (contact.customFields || []).find((f) => f.id === id);
  if (!cf) return null;
  return cf.value ?? cf.field_value ?? null;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const denied = await requireAdmin(context);
  if (denied) return denied;
  if (!env.GAINZ_GHL_TOKEN || !env.GAINZ_GHL_LOCATION) return fail(500, 'ghl_not_configured');

  const dry = new URL(request.url).searchParams.get('dry') === '1';
  const customers = await all(env.DB, `SELECT id, email, ghl_contact_id FROM customers`);
  const out = { matched: 0, unmatched: [], meals_set: 0, coupon_set: 0, errors: [] };

  for (const c of customers) {
    if (!c.email || c.email.endsWith('@stripe.local')) { out.unmatched.push(c.email); continue; }
    let contact;
    try { contact = await findGhlContactByEmail(env, c.email); }
    catch (e) { out.errors.push(`${c.email}: ${String(e).slice(0, 100)}`); continue; }
    if (!contact) { out.unmatched.push(c.email); continue; }
    out.matched++;

    const mealsRaw = readCustomField(contact, CF_SUBSCRIPTION_MEALS) ?? readCustomField(contact, CF_MEALS_PER_WEEK_LEGACY);
    const meals = parseInt(mealsRaw, 10);

    if (!dry) {
      // Link the GHL contact id (needed so the webhook's comms can reach this customer).
      await run(env.DB, `UPDATE customers SET ghl_contact_id = ?, updated_at = ? WHERE id = ?`,
        contact.id, nowIso(), c.id);

      // Fill meals_per_week on the customer's most recent subscription, if GHL had a value.
      if (Number.isFinite(meals) && meals > 0) {
        const sub = await one(env.DB,
          `SELECT id FROM subscriptions WHERE customer_id = ? ORDER BY created_at DESC LIMIT 1`, c.id);
        if (sub) {
          await run(env.DB, `UPDATE subscriptions SET meals_per_week = ?, updated_at = ? WHERE id = ?`,
            meals, nowIso(), sub.id);
          out.meals_set++;
        }
      }
    }
  }

  return ok({ dry, summary: out });
}
