// GET /.netlify/functions/stripe-check
// Diagnostic only — verifies that:
//   1. STRIPE_SECRET_KEY env var is reachable from the function runtime
//   2. The key can authenticate with Stripe API (calls /v1/balance, doesn't return amounts)
// Never returns the key value, only a boolean + auth status. Safe to call.
// DELETE this file once setup is verified.

exports.handler = async function () {
  const key = process.env.STRIPE_SECRET_KEY;
  const mode = process.env.STRIPE_MODE;

  if (!key) {
    return json(200, {
      ok: false,
      env_present: false,
      message: 'STRIPE_SECRET_KEY not visible to function runtime — check scope settings',
    });
  }

  // Don't leak the key. Show only the prefix (sk_live_ or sk_test_) and last 4 chars.
  const prefix = key.slice(0, 8);
  const tail = key.slice(-4);
  const safeRef = `${prefix}...${tail}`;

  // Call Stripe's balance endpoint — cheapest auth test
  try {
    const res = await fetch('https://api.stripe.com/v1/balance', {
      headers: { Authorization: `Bearer ${key}` },
    });
    const status = res.status;
    if (!res.ok) {
      const errBody = await res.text();
      return json(200, {
        ok: false,
        env_present: true,
        key_ref: safeRef,
        mode,
        stripe_auth_failed: true,
        stripe_status: status,
        stripe_error: errBody.slice(0, 200),
      });
    }
    // Don't return the balance details — just confirm auth worked
    return json(200, {
      ok: true,
      env_present: true,
      key_ref: safeRef,
      mode,
      stripe_auth: 'success',
    });
  } catch (e) {
    return json(500, {
      ok: false,
      env_present: true,
      key_ref: safeRef,
      mode,
      stripe_call_exception: String(e).slice(0, 200),
    });
  }
};

function json(status, payload) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(payload),
  };
}
