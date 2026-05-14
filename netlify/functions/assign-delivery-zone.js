// POST /.netlify/functions/assign-delivery-zone
//
// Triggered by GHL webhook when a customer signs up for a subscription.
// 1. Reads the contact's postal code
// 2. Maps zip → zone (1-4) using the lookup table below
// 3. Updates 3 GHL custom fields: Delivery Zone, Delivery Fee, Delivery Method
// 4. Adds tag `delivery-zone-assigned` (triggers GT — Delivery Zone Confirmation email)
// 5. Adds the matching delivery product as a recurring line item on the
//    customer's Stripe subscription (so they're auto-charged the delivery fee
//    every week alongside their meal plan)
//
// If the zip code doesn't match any zone, defaults to Pickup ($0) and adds a
// `delivery-zone-needs-review` tag so Brycen can review manually.
//
// Required env vars:
//   GAINZ_GHL_TOKEN     - GHL Private Integration Token (already used by other GT fns)
//   STRIPE_SECRET_KEY   - Stripe Secret Key (sk_live_... or sk_test_...)
//   STRIPE_MODE         - "live" or "test" (purely informational, gates whether we hit Stripe)

const GHL_API = 'https://services.leadconnectorhq.com';
const GHL_LOCATION = 'tyF96Dl8uAXn5ZD5tZ3p';
const GHL_VERSION = '2021-07-28';

// Custom field IDs (from GHL on 2026-05-13)
const CF_DELIVERY_ZONE = 'FHG0Cd306f8G7deM9OKd';
const CF_DELIVERY_FEE = 'gMKiT0gDY63ng1DRdIGS';
const CF_DELIVERY_METHOD = 'AhBEziDX79jinrGsUaP4';

// Zip → Zone mapping (Utah County focus)
// Note: 84062 (Pleasant Grove/Cedar Hills) defaults to Zone 1
// Note: 84003 (AF/Highland) defaults to Zone 2
const ZIP_TO_ZONE = {
  // Zone 1 — Orem, Provo, Lindon, Vineyard, Pleasant Grove
  '84057': 1, '84058': 1, '84097': 1,                                   // Orem + Vineyard
  '84601': 1, '84602': 1, '84603': 1, '84604': 1, '84605': 1, '84606': 1, // Provo
  '84042': 1,                                                           // Lindon
  '84062': 1,                                                           // Pleasant Grove
  // Zone 2 — American Fork, Springville, Cedar Hills, Highland, Alpine, Mapleton
  '84003': 2,                                                           // American Fork + Highland
  '84663': 2,                                                           // Springville
  '84004': 2,                                                           // Alpine
  '84664': 2,                                                           // Mapleton
  // Zone 3 — Lehi, Spanish Fork, Salem, Saratoga Springs, Eagle Mountain
  '84043': 3,                                                           // Lehi
  '84660': 3,                                                           // Spanish Fork
  '84653': 3,                                                           // Salem
  '84045': 3,                                                           // Saratoga Springs
  '84005': 3,                                                           // Eagle Mountain
  // Zone 4 — Draper, Payson, Santaquin, Bluffdale, Riverton
  '84020': 4,                                                           // Draper
  '84651': 4,                                                           // Payson
  '84655': 4,                                                           // Santaquin
  '84065': 4,                                                           // Bluffdale + Riverton (south)
  '84096': 4,                                                           // Riverton (main)
};

const ZONE_DATA = {
  1: { name: 'Zone 1', fee: 10, productId: '6a050dc0378b988c73e24d13' },
  2: { name: 'Zone 2', fee: 15, productId: '6a050dc06f41177793c7e075' },
  3: { name: 'Zone 3', fee: 20, productId: '6a050dc1e41b4470c8623ffd' },
  4: { name: 'Zone 4', fee: 25, productId: '6a050dc18817ce85827c4cc0' },
};

exports.handler = async function (event) {
  const token = process.env.GAINZ_GHL_TOKEN;
  if (!token) {
    return json(500, { ok: false, error: 'ghl_token_not_configured' });
  }

  // Parse webhook payload — GHL webhooks vary by event type, accept several shapes
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { ok: false, error: 'invalid_json' });
  }

  // Extract contactId from common GHL webhook payload shapes
  const contactId =
    payload.contact_id ||
    payload.contactId ||
    payload.contact?.id ||
    payload.customer_id ||
    payload.customerId;

  if (!contactId) {
    return json(400, { ok: false, error: 'contact_id_missing', payload_keys: Object.keys(payload) });
  }

  // Fetch full contact detail (postalCode isn't always in the webhook payload)
  let contact;
  try {
    const detailRes = await fetch(`${GHL_API}/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION },
    });
    if (!detailRes.ok) {
      return json(502, { ok: false, error: 'ghl_contact_fetch_failed', status: detailRes.status });
    }
    const data = await detailRes.json();
    contact = data.contact || data;
  } catch (e) {
    return json(500, { ok: false, error: 'ghl_fetch_exception', detail: String(e).slice(0, 200) });
  }

  // Normalize zip to first 5 digits
  const rawZip = String(contact.postalCode || '').trim();
  const zip = rawZip.slice(0, 5);

  const zoneNum = ZIP_TO_ZONE[zip] || null;

  // Handle unmapped zip → default to Pickup + needs-review tag
  if (zoneNum === null) {
    await updateContactFields(token, contactId, [
      { id: CF_DELIVERY_METHOD, field_value: 'Pickup' },
      { id: CF_DELIVERY_ZONE, field_value: 'Unmapped — review' },
      { id: CF_DELIVERY_FEE, field_value: '0' },
    ]);
    await addContactTag(token, contactId, 'delivery-zone-needs-review');
    return json(200, {
      ok: true,
      action: 'defaulted_to_pickup',
      reason: 'zip_not_in_lookup',
      zip,
      contactId,
    });
  }

  const zone = ZONE_DATA[zoneNum];

  // Update the 3 custom fields
  const fieldUpdate = await updateContactFields(token, contactId, [
    { id: CF_DELIVERY_ZONE, field_value: zone.name },
    { id: CF_DELIVERY_FEE, field_value: String(zone.fee) },
    { id: CF_DELIVERY_METHOD, field_value: 'Delivery' },
  ]);

  // Add the tag that triggers the confirmation email
  const tagAdd = await addContactTag(token, contactId, 'delivery-zone-assigned');

  // TODO: Add delivery product to Stripe subscription as recurring line item
  // Requires sk_live_... key + access to the same Stripe account that owns the sub.
  // Stub for now — returns 'stripe_pending' so we can verify the GHL side works.
  // When STRIPE_SECRET_KEY is set + Jayson's bank is verified, uncomment the Stripe block below.
  const stripeStatus = 'stripe_pending_implementation';

  /*
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (stripeKey) {
    // Look up customer's existing Stripe subscription
    // Add new line item for the delivery zone's price
    // (Implementation comes after Jayson verifies bank + we have a live key)
  }
  */

  return json(200, {
    ok: true,
    contactId,
    zip,
    zone: zone.name,
    fee: zone.fee,
    field_update: fieldUpdate ? 'success' : 'failed',
    tag_add: tagAdd ? 'success' : 'failed',
    stripe: stripeStatus,
  });
};

// ─── helpers ───────────────────────────────────────────────────────────────

async function updateContactFields(token, contactId, fields) {
  try {
    const res = await fetch(`${GHL_API}/contacts/${contactId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Version: GHL_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ customFields: fields }),
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

async function addContactTag(token, contactId, tag) {
  try {
    const res = await fetch(`${GHL_API}/contacts/${contactId}/tags`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Version: GHL_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tags: [tag] }),
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

function json(status, payload) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(payload),
  };
}
