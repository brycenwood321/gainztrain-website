// POST /.netlify/functions/switch-to-pickup
//
// Flips a customer from Delivery → Pickup. Triggered manually when customer
// replies "PICKUP" to the welcome email, OR via GHL workflow.
//
// 1. Looks up customer's Stripe sub
// 2. Removes the delivery zone subscription_item (if present)
// 3. Updates GHL custom fields: Delivery Method=Pickup, Delivery Fee=0, Delivery Zone=cleared
// 4. Adds tag `delivery-method-pickup` (replaces `delivery-zone-assigned`)
// 5. Adds a GHL note logging the switch
//
// Body: { "contactId": "..." }
// or query string: ?contactId=...

const GHL_API = 'https://services.leadconnectorhq.com';
const STRIPE_API = 'https://api.stripe.com/v1';
const GHL_LOCATION = 'tyF96Dl8uAXn5ZD5tZ3p';
const GHL_VERSION = '2021-07-28';

const CF_DELIVERY_ZONE = 'FHG0Cd306f8G7deM9OKd';
const CF_DELIVERY_FEE = 'gMKiT0gDY63ng1DRdIGS';
const CF_DELIVERY_METHOD = 'AhBEziDX79jinrGsUaP4';

async function mainLogic(event) {
  const ghlToken = process.env.GAINZ_GHL_TOKEN;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!ghlToken) return json(500, { ok: false, error: 'ghl_token_not_configured' });

  let payload = {};
  try { payload = JSON.parse(event.body || '{}'); } catch (_) {}
  const contactId = payload.contactId || event.queryStringParameters?.contactId;
  if (!contactId) return json(400, { ok: false, error: 'contact_id_required' });

  // Find Stripe subscription
  let stripeSubId = null;
  try {
    const r = await fetch(`${GHL_API}/payments/subscriptions/?altId=${GHL_LOCATION}&altType=location&contactId=${contactId}&limit=5`, {
      headers: { Authorization: `Bearer ${ghlToken}`, Version: GHL_VERSION },
    });
    if (r.ok) {
      const subs = (await r.json()).data || [];
      const active = subs.find((s) => s.status === 'active' && s.subscriptionId);
      stripeSubId = active?.subscriptionId || null;
    }
  } catch (_) {}

  // Remove delivery subscription_item from Stripe sub
  let stripeRemoved = null;
  if (stripeSubId && stripeKey) {
    try {
      const subRes = await fetch(`${STRIPE_API}/subscriptions/${stripeSubId}`, {
        headers: { Authorization: `Bearer ${stripeKey}` },
      });
      const sub = await subRes.json();
      // Find subscription items whose product name starts with "Delivery"
      const items = sub.items?.data || [];
      const deliveryItems = [];
      for (const it of items) {
        // Need product info — fetch product
        const productId = typeof it.price?.product === 'string' ? it.price.product : it.price?.product?.id;
        if (!productId) continue;
        const pr = await fetch(`${STRIPE_API}/products/${productId}`, {
          headers: { Authorization: `Bearer ${stripeKey}` },
        });
        const product = await pr.json();
        if (/Delivery\s*[—-]\s*Zone/i.test(product.name || '')) {
          deliveryItems.push({ itemId: it.id, productName: product.name });
        }
      }

      const removed = [];
      for (const di of deliveryItems) {
        const delRes = await fetch(`${STRIPE_API}/subscription_items/${di.itemId}?proration_behavior=none`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${stripeKey}` },
        });
        if (delRes.ok) removed.push(di);
      }
      stripeRemoved = { ok: true, removed };
    } catch (e) {
      stripeRemoved = { ok: false, error: String(e).slice(0, 200) };
    }
  }

  // Update GHL custom fields
  await fetch(`${GHL_API}/contacts/${contactId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${ghlToken}`, Version: GHL_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customFields: [
        { id: CF_DELIVERY_METHOD, field_value: 'Pickup' },
        { id: CF_DELIVERY_FEE, field_value: '0' },
        { id: CF_DELIVERY_ZONE, field_value: 'Pickup at Orem kitchen' },
      ],
    }),
  });

  // Swap tags
  try {
    await fetch(`${GHL_API}/contacts/${contactId}/tags`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ghlToken}`, Version: GHL_VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: ['delivery-zone-assigned'] }),
    });
  } catch (_) {}
  await fetch(`${GHL_API}/contacts/${contactId}/tags`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ghlToken}`, Version: GHL_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: ['delivery-method-pickup'] }),
  });

  // Add note
  const noteBody = [
    '🚛 Delivery → Pickup switch',
    '',
    `Customer requested pickup at the Orem kitchen instead of delivery.`,
    stripeRemoved?.removed?.length
      ? `Removed Stripe items: ${stripeRemoved.removed.map((r) => r.productName).join(', ')}`
      : 'No Stripe delivery items found to remove.',
    `Custom fields updated: Delivery Method=Pickup, Delivery Fee=0.`,
  ].join('\n');

  await fetch(`${GHL_API}/contacts/${contactId}/notes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ghlToken}`, Version: GHL_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: noteBody, userId: 'BVSNQpzruUHLvWgKX4NJ' }),
  });

  return json(200, {
    ok: true,
    action: 'switched_to_pickup',
    contactId,
    stripeSubId,
    stripe: stripeRemoved,
  });
};

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
