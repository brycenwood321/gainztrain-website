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
