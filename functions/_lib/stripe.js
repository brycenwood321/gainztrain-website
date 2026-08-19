// Minimal Stripe REST client (form-encoded). Uses the live key in prod, test key in dev.
// Supports nested params (e.g. metadata[x]) and Idempotency-Key for safe retries.

export function stripeKey(env) {
  return env.STRIPE_SECRET_KEY || env.GT_STRIPE_TEST_KEY;
}

function encodeForm(obj, prefix, form) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item && typeof item === 'object') encodeForm(item, `${key}[${i}]`, form);
        else form.append(`${key}[${i}]`, String(item));
      });
    } else if (v && typeof v === 'object') {
      encodeForm(v, key, form);
    } else {
      form.append(key, String(v));
    }
  }
  return form;
}

export async function stripe(env, method, path, params, idempotencyKey) {
  const key = stripeKey(env);
  if (!key) throw Object.assign(new Error('stripe_key_missing'), { code: 'stripe_key_missing' });

  const headers = { Authorization: `Bearer ${key}` };

  // ⚠️ PIN THE API VERSION. Without a Stripe-Version header every call runs on whatever the ACCOUNT's
  // default version happens to be — so Stripe can move a field and this codebase changes behaviour
  // with zero deploys and zero errors. That is not hypothetical here: `invoice.subscription` moved to
  // invoice.parent.subscription_details, and `current_period_end` moved onto subscription ITEMS. Both
  // returned null SILENTLY and each one cost real money before anyone noticed.
  //
  // Deliberately NOT hardcoded. Guessing a version would change live billing behaviour the moment it
  // deploys. Set STRIPE_API_VERSION to the value shown in the Stripe dashboard (Developers → API
  // version) — that pins today's behaviour with no change — then upgrade on purpose, reading the
  // migration notes, instead of being upgraded silently.
  if (env.STRIPE_API_VERSION) headers['Stripe-Version'] = env.STRIPE_API_VERSION;

  let url = `https://api.stripe.com/v1/${path}`;
  const init = { method, headers };

  if (method === 'GET') {
    if (params) url += '?' + encodeForm(params, '', new URLSearchParams()).toString();
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    init.body = params ? encodeForm(params, '', new URLSearchParams()).toString() : '';
  }

  const r = await fetch(url, init);
  const body = await r.json();
  if (!r.ok) {
    const err = new Error(body?.error?.message || `stripe_error_${r.status}`);
    err.stripe = body?.error;
    err.status = r.status;
    throw err;
  }
  return body;
}
