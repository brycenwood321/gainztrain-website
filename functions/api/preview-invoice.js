// GET /api/preview-invoice?sub=sub_xxx
// Returns what Stripe would charge on the customer's next invoice for a given sub.
// Confirms forever-discount is actually being applied to recurring charges.
// DELETE after launch verification.

async function mainLogic(event) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return json(500, { ok: false, error: 'stripe_key_missing' });

  const subId = event.queryStringParameters?.sub;
  if (!subId) return json(400, { ok: false, error: 'sub_param_required' });

  // 1. Get sub to find customer + discounts
  const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subId}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!subRes.ok) return json(200, { ok: false, error: 'sub_fetch_failed' });
  const sub = await subRes.json();
  const customerId = sub.customer;

  // 2. Get preview of next invoice (newer Stripe API)
  const previewBody = new URLSearchParams();
  previewBody.append('customer', customerId);
  previewBody.append('subscription', subId);
  const invRes = await fetch(`https://api.stripe.com/v1/invoices/create_preview`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: previewBody,
  });
  if (!invRes.ok) {
    const body = await invRes.text();
    return json(200, { ok: false, error: 'upcoming_invoice_failed', body: body.slice(0, 400) });
  }
  const inv = await invRes.json();

  // 3. Fetch coupon details for each discount on the sub
  const discountInfo = [];
  for (const d of (sub.discounts || [])) {
    const dId = typeof d === 'string' ? d : d.id;
    if (!dId) continue;
    const dr = await fetch(`https://api.stripe.com/v1/discounts/${dId}?expand[]=coupon`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (dr.ok) {
      const dd = await dr.json();
      discountInfo.push({
        id: dd.id,
        coupon_id: dd.coupon?.id,
        coupon_name: dd.coupon?.name,
        percent_off: dd.coupon?.percent_off,
        duration: dd.coupon?.duration,
        valid: dd.coupon?.valid,
      });
    }
  }

  return json(200, {
    ok: true,
    sub_id: sub.id,
    customer: customerId,
    discounts_on_sub: discountInfo,
    upcoming_invoice: {
      next_payment_attempt: inv.next_payment_attempt,
      period_start: inv.period_start,
      period_end: inv.period_end,
      subtotal: inv.subtotal / 100,
      total_discount: inv.total_discount_amounts?.reduce((a, b) => a + (b.amount || 0), 0) / 100 || 0,
      total: inv.total / 100,
      amount_due: inv.amount_due / 100,
      lines: (inv.lines?.data || []).map((l) => ({
        description: l.description,
        amount: l.amount / 100,
        period_start: l.period?.start,
        period_end: l.period?.end,
      })),
    },
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
