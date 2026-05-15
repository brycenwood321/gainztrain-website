// POST /.netlify/functions/assign-delivery-zone
//
// Triggered by GHL webhook when a customer signs up for a meal subscription.
// 1. Reads contact postalCode → maps to zone via ZIP_TO_ZONE table
// 2. Updates 3 GHL custom fields: Delivery Zone, Delivery Fee, Delivery Method
// 3. Adds tag `delivery-zone-assigned` (triggers GT — Delivery Zone Confirmation email)
// 4. Looks up customer's Stripe subscription via GHL → adds delivery zone
//    product as a recurring subscription item (auto-charged weekly alongside
//    their meal plan)
//
// If zip doesn't match any zone: defaults to Pickup, adds `delivery-zone-needs-review` tag.
// Accepts ?dryRun=1 to skip Stripe writes (for testing).
//
// Required env vars:
//   GAINZ_GHL_TOKEN     - GHL Private Integration Token
//   STRIPE_SECRET_KEY   - Stripe Secret Key (live or test)

const GHL_API = 'https://services.leadconnectorhq.com';
const STRIPE_API = 'https://api.stripe.com/v1';
const GHL_LOCATION = 'tyF96Dl8uAXn5ZD5tZ3p';
const GHL_VERSION = '2021-07-28';

const CF_DELIVERY_ZONE = 'FHG0Cd306f8G7deM9OKd';
const CF_DELIVERY_FEE = 'gMKiT0gDY63ng1DRdIGS';
const CF_DELIVERY_METHOD = 'AhBEziDX79jinrGsUaP4';

// Zip → Zone (Utah County)
const ZIP_TO_ZONE = {
  // Zone 1 — Orem, Provo, Lindon, Vineyard, Pleasant Grove (within 5 mi)
  '84057': 1, '84058': 1, '84097': 1,
  '84601': 1, '84602': 1, '84603': 1, '84604': 1, '84605': 1, '84606': 1,
  '84042': 1, '84062': 1,
  // Zone 2 — American Fork, Springville, Cedar Hills, Highland, Alpine, Mapleton (5-10 mi)
  '84003': 2, '84663': 2, '84004': 2, '84664': 2,
  // Zone 3 — Lehi, Spanish Fork, Salem, Saratoga Springs, Eagle Mountain (10-15 mi)
  '84043': 3, '84660': 3, '84653': 3, '84045': 3, '84005': 3,
  // Zone 4 — Draper, Payson, Santaquin, Bluffdale, Riverton (15-25 mi)
  '84020': 4, '84651': 4, '84655': 4, '84065': 4, '84096': 4,
};

const ZONE_DATA = {
  1: { name: 'Zone 1', fee: 10 },
  2: { name: 'Zone 2', fee: 15 },
  3: { name: 'Zone 3', fee: 20 },
  4: { name: 'Zone 4', fee: 25 },
};

// Cached Stripe price IDs (looked up on first invocation, kept warm across calls)
let stripePricesByZone = null;

async function mainLogic(event) {
  const ghlToken = process.env.GAINZ_GHL_TOKEN;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!ghlToken) return json(500, { ok: false, error: 'ghl_token_not_configured' });

  // Parse payload
  let payload = {};
  try { payload = JSON.parse(event.body || '{}'); } catch (_) {}
  const contactId = payload.contactId || payload.contact_id || payload.contact?.id || event.queryStringParameters?.contactId;
  const dryRun = event.queryStringParameters?.dryRun === '1' || payload.dryRun === true;
  if (!contactId) return json(400, { ok: false, error: 'contact_id_required' });

  // Fetch GHL contact
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

  const zip = String(contact.postalCode || '').slice(0, 5);
  const zoneNum = ZIP_TO_ZONE[zip] || null;

  // Unmapped zip → default to pickup, tag for review
  if (zoneNum === null) {
    if (!dryRun) {
      await updateContactFields(ghlToken, contactId, [
        { id: CF_DELIVERY_METHOD, field_value: 'Pickup' },
        { id: CF_DELIVERY_ZONE, field_value: 'Unmapped — review' },
        { id: CF_DELIVERY_FEE, field_value: '0' },
      ]);
      await addContactTag(ghlToken, contactId, 'delivery-zone-needs-review');
    }
    return json(200, {
      ok: true, action: 'defaulted_to_pickup', reason: 'zip_not_in_lookup',
      zip, contactId, dryRun,
    });
  }

  const zone = ZONE_DATA[zoneNum];

  // Find customer's Stripe subscription via GHL — and capture coupon code used at checkout
  let stripeSubId = null;
  let ghlCouponCode = null;
  try {
    const subUrl = `${GHL_API}/payments/subscriptions/?altId=${GHL_LOCATION}&altType=location&contactId=${contactId}&limit=5`;
    const r = await fetch(subUrl, { headers: { Authorization: `Bearer ${ghlToken}`, Version: GHL_VERSION } });
    if (r.ok) {
      const subs = (await r.json()).data || [];
      const active = subs.find((s) => s.status === 'active' && s.subscriptionId);
      stripeSubId = active?.subscriptionId || null;
      ghlCouponCode = active?.couponCode || null;
    }
  } catch (_) {}

  // Coupon attach: critical workaround for GHL bug where coupons don't sync as
  // "forever" discounts to Stripe. If the customer checked out with a coupon
  // code, attach the corresponding Stripe coupon to their subscription so all
  // future recurring charges get discounted.
  let couponResult = null;
  if (stripeSubId && stripeKey && ghlCouponCode && !dryRun) {
    try {
      // Check if discount is already on the sub
      const checkRes = await fetch(`${STRIPE_API}/subscriptions/${stripeSubId}`, {
        headers: { Authorization: `Bearer ${stripeKey}` },
      });
      const checkData = await checkRes.json();
      const hasDiscount = (checkData.discounts || []).length > 0 || checkData.discount;
      if (hasDiscount) {
        couponResult = { ok: true, action: 'already_has_discount', coupon: ghlCouponCode };
      } else {
        const body = new URLSearchParams();
        body.append('discounts[0][coupon]', ghlCouponCode);
        const r = await fetch(`${STRIPE_API}/subscriptions/${stripeSubId}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
        const d = await r.json();
        couponResult = r.ok
          ? { ok: true, action: 'coupon_attached', coupon: ghlCouponCode }
          : { ok: false, error: d.error?.message || 'coupon_attach_failed', coupon: ghlCouponCode };
      }
    } catch (e) {
      couponResult = { ok: false, error: 'coupon_exception', detail: String(e).slice(0, 200) };
    }
  }

  // Stripe operations: add the delivery zone as a subscription item
  let stripeResult = null;
  if (stripeSubId && stripeKey && !dryRun) {
    try {
      // Cache Stripe price IDs on first call
      if (!stripePricesByZone) {
        stripePricesByZone = await loadDeliveryPrices(stripeKey);
      }
      const priceId = stripePricesByZone[zoneNum];
      if (!priceId) {
        stripeResult = { ok: false, error: 'stripe_price_not_found', zone: zone.name };
      } else {
        // Check if customer already has this delivery price (avoid duplicates)
        const subCheck = await fetch(`${STRIPE_API}/subscriptions/${stripeSubId}`, {
          headers: { Authorization: `Bearer ${stripeKey}` },
        });
        const subData = await subCheck.json();
        const alreadyHas = (subData.items?.data || []).some((it) => it.price?.id === priceId);
        if (alreadyHas) {
          stripeResult = { ok: true, action: 'already_added', priceId };
        } else {
          const body = new URLSearchParams({
            subscription: stripeSubId,
            price: priceId,
            proration_behavior: 'none',  // don't pro-rate, full fee starts next cycle
          });
          const addRes = await fetch(`${STRIPE_API}/subscription_items`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${stripeKey}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
          });
          const addData = await addRes.json();
          stripeResult = addRes.ok
            ? { ok: true, action: 'added_subscription_item', itemId: addData.id, priceId }
            : { ok: false, error: addData.error?.message || 'stripe_add_failed', priceId };
        }
      }
    } catch (e) {
      stripeResult = { ok: false, error: 'stripe_exception', detail: String(e).slice(0, 200) };
    }
  } else if (dryRun) {
    stripeResult = { ok: true, action: 'dry_run_skipped' };
  } else if (!stripeSubId) {
    stripeResult = { ok: false, error: 'no_active_stripe_sub_found' };
  } else if (!stripeKey) {
    stripeResult = { ok: false, error: 'stripe_key_missing' };
  }

  // Update GHL custom fields + tag (skip on dryRun)
  if (!dryRun) {
    await updateContactFields(ghlToken, contactId, [
      { id: CF_DELIVERY_ZONE, field_value: zone.name },
      { id: CF_DELIVERY_FEE, field_value: String(zone.fee) },
      { id: CF_DELIVERY_METHOD, field_value: 'Delivery' },
    ]);
    await addContactTag(ghlToken, contactId, 'delivery-zone-assigned');
  }

  return json(200, {
    ok: true, action: 'delivery_zone_assigned', dryRun,
    contactId, zip, zone: zone.name, fee: zone.fee,
    stripeSubId,
    ghlCouponCode,
    coupon: couponResult,
    stripe: stripeResult,
  });
};

// ─── helpers ───────────────────────────────────────────────────────────────

async function loadDeliveryPrices(stripeKey) {
  // List Stripe products with name containing "Delivery — Zone N",
  // return { 1: price_xxx, 2: price_yyy, 3: ..., 4: ... }
  const out = {};
  const r = await fetch(`${STRIPE_API}/products?active=true&limit=100`, {
    headers: { Authorization: `Bearer ${stripeKey}` },
  });
  const data = await r.json();
  const deliveryProducts = (data.data || []).filter((p) => /Delivery\s*[—-]\s*Zone\s*[1-4]/i.test(p.name || ''));
  for (const p of deliveryProducts) {
    const m = (p.name || '').match(/Zone\s*([1-4])/i);
    if (!m) continue;
    const zoneNum = parseInt(m[1], 10);
    // Fetch prices for this product
    const pr = await fetch(`${STRIPE_API}/prices?product=${p.id}&active=true&limit=5`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
    });
    const prData = await pr.json();
    const recurring = (prData.data || []).find((pr) => pr.type === 'recurring');
    if (recurring) out[zoneNum] = recurring.id;
  }
  return out;
}

async function updateContactFields(token, contactId, fields) {
  try {
    const r = await fetch(`${GHL_API}/contacts/${contactId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify({ customFields: fields }),
    });
    return r.ok;
  } catch (_) { return false; }
}

async function addContactTag(token, contactId, tag) {
  try {
    const r = await fetch(`${GHL_API}/contacts/${contactId}/tags`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: [tag] }),
    });
    return r.ok;
  } catch (_) { return false; }
}

function json(status, payload) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(payload),
  };
}


// Cloudflare Pages Functions handler — wraps the Netlify-style handler logic below.
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const event = {
    body: request.method !== 'GET' ? await request.text() : '',
    queryStringParameters: Object.fromEntries(url.searchParams),
    httpMethod: request.method,
  };
  // Polyfill process.env so the existing code's process.env.X references work
  globalThis.process = globalThis.process || {};
  globalThis.process.env = env;

  const result = await mainLogic(event);
  return new Response(result.body, {
    status: result.statusCode || 200,
    headers: result.headers || { 'Content-Type': 'application/json' },
  });
}
