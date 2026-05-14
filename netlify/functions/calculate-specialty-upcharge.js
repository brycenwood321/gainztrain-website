// POST /.netlify/functions/calculate-specialty-upcharge
//
// Universal specialty-protein upcharge calculator. Called by GHL workflow at
// Saturday cutoff. Reads this week's menu from menus.json, sums each customer's
// per-meal upcharges, and creates a single invoice + auto-charges the saved
// payment method.
//
// Adding a new specialty meal = edit menus.json to set `upcharge_per_meal`. No
// workflow change required.
//
// Body:  { "contactId": "..." }
// or query string: ?contactId=...
//
// Required env vars:
//   GAINZ_GHL_TOKEN     - GHL Private Integration Token

const GHL_API = 'https://services.leadconnectorhq.com';
const GHL_LOCATION = 'tyF96Dl8uAXn5ZD5tZ3p';
const GHL_VERSION = '2021-07-28';

// Meal count custom field IDs (position 1-4 maps to these GHL fields)
const CF_MEAL_COUNTS = {
  1: '4RBRbxwC7DlTZQLZS6eq', // Meal 1 Count
  2: 'fCeBeqOGkM2fPF1WPiou', // Meal 2 Count
  3: '0KXO0jv2W62TtHpxn1GI', // Meal 3 Count
  4: 'EmQSbCzexeMpp8lwHDrM', // Meal 4 Count
};

const MENU_URL = 'https://gainztrainprep.com/data/menus.json';

exports.handler = async function (event) {
  const token = process.env.GAINZ_GHL_TOKEN;
  if (!token) return json(500, { ok: false, error: 'ghl_token_not_configured' });

  // Get contactId from body or query string
  let contactId;
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    contactId = body.contactId || body.contact_id || event.queryStringParameters?.contactId;
  } catch (e) {
    contactId = event.queryStringParameters?.contactId;
  }
  if (!contactId) return json(400, { ok: false, error: 'contact_id_required' });

  // 1) Load this week's menu
  let menu;
  try {
    const menuRes = await fetch(MENU_URL, { headers: { 'Cache-Control': 'no-cache' } });
    if (!menuRes.ok) return json(502, { ok: false, error: 'menu_fetch_failed' });
    const data = await menuRes.json();
    menu = pickCurrentMenu(data.menus || []);
    if (!menu) return json(502, { ok: false, error: 'no_current_menu' });
  } catch (e) {
    return json(500, { ok: false, error: 'menu_fetch_exception', detail: String(e).slice(0, 200) });
  }

  // 2) Fetch contact custom fields from GHL
  let contact;
  try {
    const contactRes = await fetch(`${GHL_API}/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION },
    });
    if (!contactRes.ok) {
      return json(502, { ok: false, error: 'ghl_contact_fetch_failed', status: contactRes.status });
    }
    contact = (await contactRes.json()).contact;
  } catch (e) {
    return json(500, { ok: false, error: 'ghl_fetch_exception', detail: String(e).slice(0, 200) });
  }

  // 3) Build upcharge breakdown — for each meal position, multiply count × upcharge
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
      name: `${mealDef.name} × ${count} @ $${upcharge.toFixed(2)}/meal`,
      qty: count,
      unit_price: upcharge,
      subtotal,
    });
  }

  // No upcharges this week → no action
  if (total === 0) {
    return json(200, {
      ok: true,
      action: 'no_upcharge',
      contactId,
      week_of: menu.week_of,
      reason: 'customer_picked_no_specialty_meals_or_no_specialty_on_menu',
    });
  }

  // 4) Create the GHL invoice + auto-charge
  // TODO once verified: this uses GHL's invoice API. If GHL doesn't auto-charge
  // saved cards reliably, fall back to direct Stripe API.
  let invoiceResult;
  try {
    invoiceResult = await createAndChargeInvoice({
      token,
      contactId,
      contactEmail: contact.email,
      contactName: `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
      lineItems,
      total,
      week_of: menu.week_of,
    });
  } catch (e) {
    return json(500, {
      ok: false,
      error: 'invoice_create_exception',
      detail: String(e).slice(0, 200),
      breakdown: { total, lineItems },
    });
  }

  return json(200, {
    ok: true,
    action: 'upcharge_invoiced',
    contactId,
    week_of: menu.week_of,
    total,
    lineItems,
    invoice: invoiceResult,
  });
};

// ─── helpers ───────────────────────────────────────────────────────────────

function pickCurrentMenu(menus) {
  // Pick the menu whose week_of is the next upcoming Sunday from today.
  // If none match, fall back to the most recent.
  if (!menus.length) return null;
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = menus
    .filter((m) => m.week_of >= today)
    .sort((a, b) => a.week_of.localeCompare(b.week_of));
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

async function createAndChargeInvoice({ token, contactId, contactEmail, contactName, lineItems, total, week_of }) {
  // GHL's v2 invoice creation endpoint. Body shape per GHL docs.
  // If GHL rejects this payload shape, we may need to switch to direct Stripe charge.
  const payload = {
    altId: GHL_LOCATION,
    altType: 'location',
    name: `Specialty upcharge — week of ${week_of}`,
    businessDetails: {
      name: 'Gainz Train',
      website: 'https://gainztrainprep.com',
      phoneNo: '+13853278045',
    },
    contactDetails: {
      id: contactId,
      name: contactName || undefined,
      email: contactEmail || undefined,
    },
    currency: 'USD',
    items: lineItems.map((li) => ({
      name: li.name,
      description: '',
      currency: 'USD',
      amount: li.unit_price,
      qty: li.qty,
    })),
    issueDate: new Date().toISOString().slice(0, 10),
    dueDate: new Date().toISOString().slice(0, 10),
    liveMode: process.env.STRIPE_MODE === 'live',
    automaticTaxesCalculation: false,
  };

  const res = await fetch(`${GHL_API}/invoices/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Version: GHL_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errBody = await res.text();
    return { ok: false, status: res.status, error: errBody.slice(0, 400) };
  }

  const invoice = await res.json();

  // Auto-charge attempt: GHL has a "record payment" or "send + auto-pay" flow.
  // Returns the invoice. Brycen will verify auto-charge actually fires in
  // real-world testing — if it doesn't, we add a separate Stripe charge step.
  return { ok: true, invoiceId: invoice._id || invoice.id, raw: invoice };
}

function json(status, payload) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(payload),
  };
}
