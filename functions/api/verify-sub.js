// GET /.netlify/functions/verify-sub?sub=sub_xxx
// Diagnostic: returns line items + discount info for a Stripe subscription.
// Used to verify OWNERS100/FAMFRIENDS15 forever-discount status + sub state.
// Doesn't expose sensitive payment data. DELETE after launch verification done.

async function mainLogic(event) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return json(500, { ok: false, error: 'stripe_key_missing' });

  const subId = event.queryStringParameters?.sub;
  if (!subId) return json(400, { ok: false, error: 'sub_param_required' });

  try {
    const r = await fetch(`https://api.stripe.com/v1/subscriptions/${subId}?expand[]=discounts.coupon&expand[]=discount.coupon`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
    });
    if (!r.ok) {
      return json(200, { ok: false, error: 'stripe_fetch_failed', status: r.status, body: (await r.text()).slice(0, 300) });
    }
    const sub = await r.json();
    return json(200, {
      ok: true,
      sub_id: sub.id,
      status: sub.status,
      customer: sub.customer,
      currency: sub.currency,
      collection_method: sub.collection_method,
      current_period_end: sub.current_period_end,
      items: (sub.items?.data || []).map((i) => ({
        item_id: i.id,
        price_id: i.price?.id,
        product: i.price?.product,
        unit_amount: i.price?.unit_amount,
        currency: i.price?.currency,
        interval: i.price?.recurring?.interval,
      })),
      discount: sub.discount
        ? {
            coupon_id: sub.discount.coupon?.id,
            coupon_name: sub.discount.coupon?.name,
            duration: sub.discount.coupon?.duration,
            percent_off: sub.discount.coupon?.percent_off,
            amount_off: sub.discount.coupon?.amount_off,
            valid: sub.discount.coupon?.valid,
          }
        : null,
      discounts: (sub.discounts || []).map((d) => ({
        discount_id: d.id,
        coupon_id: d.coupon?.id,
        coupon_name: d.coupon?.name,
        duration: d.coupon?.duration,
        percent_off: d.coupon?.percent_off,
        valid: d.coupon?.valid,
      })),
      latest_invoice: sub.latest_invoice,
    });
  } catch (e) {
    return json(500, { ok: false, error: 'stripe_exception', detail: String(e).slice(0, 200) });
  }
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
