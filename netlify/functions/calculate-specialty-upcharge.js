// POST /.netlify/functions/calculate-specialty-upcharge
//
// Universal specialty-protein upcharge calculator. Called by GHL workflow at
// Saturday cutoff. Reads this week's menu from menus.json, sums each customer's
// per-meal upcharges, and adds each upcharge as a Stripe invoice item against
// the customer (auto-billed on next subscription invoice on Sunday).
//
// Adding a new specialty meal = edit menus.json to set `upcharge_per_meal`. No
// workflow change required.
//
// Body:   { "contactId": "...", "dryRun": true|false }
//
// Required env vars:
//   GAINZ_GHL_TOKEN     - GHL Private Integration Token
//   STRIPE_SECRET_KEY   - Stripe Secret Key (live or test)

const GHL_API = 'https://services.leadconnectorhq.com';
const STRIPE_API = 'https://api.stripe.com/v1';
const GHL_LOCATION = 'tyF96Dl8uAXn5ZD5tZ3p';
const GHL_VERSION = '2021-07-28';

// Meal count custom field IDs (position 1-4 → GHL custom field)
const CF_MEAL_COUNTS = {
  1: '4RBRbxwC7DlTZQLZS6eq', // Meal 1 Count
  2: 'fCeBeqOGkM2fPF1WPiou', // Meal 2 Count
  3: '0KXO0jv2W62TtHpxn1GI', // Meal 3 Count
  4: 'EmQSbCzexeMpp8lwHDrM', // Meal 4 Count
};

const MENU_URL = 'https://gainztrainprep.com/data/menus.json';

exports.handler = async function (event) {
  const ghlToken = process.env.GAINZ_GHL_TOKEN;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!ghlToken) return json(500, { ok: false, error: 'ghl_token_not_configured' });

  // Parse input
  let payload = {};
  try { payload = JSON.parse(event.body || '{}'); } catch (_) {}
  const contactId = payload.contactId || payload.contact_id || event.queryStringParameters?.contactId;
  const dryRun = payload.dryRun === true || event.queryStringParameters?.dryRun === '1';
  if (!contactId) return json(400, { ok: false, error: 'contact_id_required' });

  // 1. Load this week's menu
  let menu;
  try {
    const r = await fetch(MENU_URL, { headers: { 'Cache-Control': 'no-cache' } });
    if (!r.ok) return json(502, { ok: false, error: 'menu_fetch_failed' });
    const data = await r.json();
    menu = pickCurrentMenu(data.menus || []);
    if (!menu) return json(502, { ok: false, error: 'no_current_menu' });
  } catch (e) {
    return json(500, { ok: false, error: 'menu_exception', detail: String(e).slice(0, 200) });
  }

  // 2. Get contact custom fields from GHL
  let contact;
  try {
    const r = await fetch(`${GHL_API}/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${ghlToken}`, Version: GHL_VERSION },
    });
    if (!r.ok) return json(502, { ok: false, error: 'ghl_contact_fetch_failed', status: r.status });
    contact = (await r.json()).contact;
  } catch (e) {
    return json(500, { ok: false, error: 'ghl_fetch_exception', detail: String(e).slice(0, 200) });
  }

  // 3. Calculate breakdown: for each meal position with upcharge_per_meal > 0,
  //    multiply by the customer's count for that position.
  const lineItems = [];
  let total = 0;
  for (const mealDef of menu.meals) {
    const upcharge = parseFloat(mealDef.upcharge_per_meal || 0);
    if (upcharge <= 0) continue;
    const cfId = CF_MEAL_COUNTS[mealDef.position];
    if (!cfId) continue;
    const count = parseInt(readCustomField(contact, cfId), 10);
    if (!Number.isFinite(count) || count <= 0) continue;
    const subtotal = round2(count * upcharge);
    total = round2(total + subtotal);
    lineItems.push({
      name: mealDef.name,
      qty: count,
      unit_price: upcharge,
      subtotal,
      description: `${mealDef.name} × ${count} @ $${upcharge.toFixed(2)}/meal — week of ${menu.week_of}`,
    });
  }

  if (total === 0) {
    return json(200, {
      ok: true,
      action: 'no_upcharge',
      contactId,
      week_of: menu.week_of,
      reason: 'no_specialty_picks_or_no_specialty_on_menu',
    });
  }

  // 4. Find Stripe subscription + customer for this contact
  let stripeSubId = null;
  try {
    const subUrl = `${GHL_API}/payments/subscriptions/?altId=${GHL_LOCATION}&altType=location&contactId=${contactId}&limit=5`;
    const r = await fetch(subUrl, { headers: { Authorization: `Bearer ${ghlToken}`, Version: GHL_VERSION } });
    if (r.ok) {
      const subs = (await r.json()).data || [];
      const active = subs.find((s) => s.status === 'active' && s.subscriptionId);
      stripeSubId = active?.subscriptionId || null;
    }
  } catch (_) {}

  if (!stripeSubId) {
    return json(200, {
      ok: false,
      error: 'no_active_stripe_sub_found',
      contactId,
      total, lineItems,
    });
  }

  if (!stripeKey) {
    return json(200, {
      ok: false,
      error: 'stripe_key_missing',
      contactId,
      total, lineItems,
    });
  }

  // 5. Get Stripe customer ID + period_end from the subscription
  let stripeCustomerId, periodEnd;
  try {
    const r = await fetch(`${STRIPE_API}/subscriptions/${stripeSubId}`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
    });
    const d = await r.json();
    stripeCustomerId = d.customer;
    periodEnd = d.current_period_end;
  } catch (e) {
    return json(500, { ok: false, error: 'stripe_sub_fetch_exception', detail: String(e).slice(0, 200) });
  }

  // 6. Create Stripe invoice items — added to customer's next invoice automatically
  if (dryRun) {
    return json(200, {
      ok: true,
      action: 'dry_run',
      contactId, total, lineItems,
      stripeSubId, stripeCustomerId,
      would_create_invoice_items: lineItems.length,
    });
  }

  const created = [];
  const failed = [];
  for (const li of lineItems) {
    const body = new URLSearchParams({
      customer: stripeCustomerId,
      subscription: stripeSubId,
      currency: 'usd',
      amount: String(Math.round(li.subtotal * 100)), // cents
      description: li.description,
    });
    try {
      const r = await fetch(`${STRIPE_API}/invoiceitems`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const d = await r.json();
      if (r.ok) {
        created.push({ id: d.id, amount: d.amount / 100, description: d.description });
      } else {
        failed.push({ name: li.name, error: d.error?.message });
      }
    } catch (e) {
      failed.push({ name: li.name, error: String(e).slice(0, 200) });
    }
  }

  return json(200, {
    ok: failed.length === 0,
    action: 'invoice_items_created',
    contactId,
    week_of: menu.week_of,
    total,
    lineItems,
    stripeSubId,
    stripeCustomerId,
    created,
    failed,
  });
};

// ─── helpers ───────────────────────────────────────────────────────────────

function pickCurrentMenu(menus) {
  if (!menus.length) return null;
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = menus.filter((m) => m.week_of >= today).sort((a, b) => a.week_of.localeCompare(b.week_of));
  if (upcoming.length) return upcoming[0];
  return menus.slice().sort((a, b) => b.week_of.localeCompare(a.week_of))[0];
}

function readCustomField(contact, fieldId) {
  const cf = contact.customFields || contact.customField || [];
  if (Array.isArray(cf)) {
    const hit = cf.find((f) => f.id === fieldId);
    return hit ? (hit.value != null ? hit.value : hit.field_value) : null;
  }
  if (typeof cf === 'object' && cf[fieldId] != null) return cf[fieldId];
  return null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function json(status, payload) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(payload),
  };
}
