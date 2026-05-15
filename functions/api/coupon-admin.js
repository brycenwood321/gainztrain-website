// /.netlify/functions/coupon-admin
// One-shot admin endpoint for fixing the missing Stripe coupons on our 3 live subs.
//
// GET ?action=list_coupons         → list Stripe coupons
// POST {action:"create_coupons"}   → idempotently create OWNERS100 + FAMFRIENDS15 in Stripe (forever)
// POST {action:"attach", sub:"sub_xxx", coupon:"OWNERS100"|"FAMFRIENDS15"} → attach coupon to sub
//
// DELETE after launch verification done.

async function mainLogic(event) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return json(500, { ok: false, error: 'stripe_key_missing' });

  const method = event.httpMethod;
  let payload = {};
  if (event.body) try { payload = JSON.parse(event.body); } catch (_) {}
  const action = payload.action || event.queryStringParameters?.action;

  if (action === 'list_coupons') {
    const r = await fetch('https://api.stripe.com/v1/coupons?limit=20', {
      headers: { Authorization: `Bearer ${key}` },
    });
    const data = await r.json();
    return json(200, {
      ok: r.ok,
      coupons: (data.data || []).map((c) => ({
        id: c.id,
        name: c.name,
        percent_off: c.percent_off,
        amount_off: c.amount_off,
        duration: c.duration,
        valid: c.valid,
        times_redeemed: c.times_redeemed,
      })),
    });
  }

  if (action === 'create_coupons') {
    // Idempotent: tries to create, ignores duplicate errors
    const results = {};
    const toCreate = [
      { id: 'OWNERS100', name: 'Owners & Family — 100% Comp', percent_off: 100, duration: 'forever' },
      { id: 'FAMFRIENDS15', name: 'Family & Friends — 15% Off For Life', percent_off: 15, duration: 'forever' },
      { id: 'FOUNDER25', name: 'Founding Member — 25% Off First Order', percent_off: 25, duration: 'once' },
    ];
    for (const c of toCreate) {
      const body = new URLSearchParams({
        id: c.id,
        name: c.name,
        percent_off: String(c.percent_off),
        duration: c.duration,
      });
      const r = await fetch('https://api.stripe.com/v1/coupons', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const data = await r.json();
      results[c.id] = r.ok ? { created: true, id: data.id } : { created: false, error: data.error?.message };
    }
    return json(200, { ok: true, results });
  }

  if (action === 'attach') {
    const sub = payload.sub;
    const couponId = payload.coupon;
    if (!sub || !couponId) return json(400, { ok: false, error: 'sub_and_coupon_required' });
    // New Stripe API uses discounts[] array instead of singular coupon param
    const body = new URLSearchParams();
    body.append('discounts[0][coupon]', couponId);
    const r = await fetch(`https://api.stripe.com/v1/subscriptions/${sub}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await r.json();
    if (!r.ok) return json(200, { ok: false, error: data.error?.message, status: r.status });
    return json(200, {
      ok: true,
      sub_id: data.id,
      discounts: (data.discounts || []).map((d) => ({ id: d.id, coupon: d.coupon })),
    });
  }

  if (action === 'list_pending_invoiceitems') {
    const customer = payload.customer || event.queryStringParameters?.customer;
    if (!customer) return json(400, { ok: false, error: 'customer_required' });
    const r = await fetch(`https://api.stripe.com/v1/invoiceitems?customer=${customer}&limit=50&pending=true`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const data = await r.json();
    return json(200, {
      ok: r.ok,
      items: (data.data || []).map((i) => ({
        id: i.id,
        amount: i.amount / 100,
        currency: i.currency,
        description: i.description,
        invoice: i.invoice,
        proration: i.proration,
      })),
    });
  }

  if (action === 'delete_invoiceitem') {
    const itemId = payload.itemId || event.queryStringParameters?.itemId;
    if (!itemId) return json(400, { ok: false, error: 'itemId_required' });
    const r = await fetch(`https://api.stripe.com/v1/invoiceitems/${itemId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${key}` },
    });
    const data = await r.json();
    return json(200, { ok: r.ok, deleted: data.deleted, id: data.id });
  }

  return json(400, { ok: false, error: 'unknown_action', valid: ['list_coupons', 'create_coupons', 'attach', 'list_pending_invoiceitems', 'delete_invoiceitem'] });
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
