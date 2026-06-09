// GET /api/get-subscription?email=foo@bar.com
// Returns the contact's subscription_meals value so the menu page can
// render the counter even when the URL-param-passing chain misses it
// (e.g. race condition between order submission and the GT - Set
// Subscription Meals workflow finishing).

const GHL_API = 'https://services.leadconnectorhq.com';
const GHL_LOCATION = 'tyF96Dl8uAXn5ZD5tZ3p';
// Field IDs (GHL's contact API returns customFields as {id, value} pairs, NOT keyed by name)
const CF_SUBSCRIPTION_MEALS_ID = 'xsIiGkYsROz2cwRiNxvZ';
const CF_MEALS_PER_WEEK_ID = 'yUT9K2GPlmHxhodOFUjq'; // legacy fallback

async function mainLogic(event) {
  const token = process.env.GAINZ_GHL_TOKEN;
  if (!token) {
    return json(500, { ok: false, error: 'token_not_configured' });
  }

  const params = event.queryStringParameters || {};
  const email = (params.email || '').trim().toLowerCase();
  if (!email) return json(400, { ok: false, error: 'email_required' });

  const headers = {
    Authorization: `Bearer ${token}`,
    Version: '2021-07-28',
  };

  try {
    const url = `${GHL_API}/contacts/?locationId=${GHL_LOCATION}&query=${encodeURIComponent(email)}&limit=5`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      return json(502, { ok: false, error: 'search_failed' });
    }
    const data = await res.json();
    const contacts = data.contacts || [];
    const match = contacts.find((c) => (c.email || '').toLowerCase() === email);
    if (!match) {
      return json(404, { ok: false, error: 'contact_not_found' });
    }

    // GHL returns customFields as an array of {id, value} objects when fetched
    // via the search endpoint, but the search response usually doesn't include
    // them — so fetch the contact detail.
    const detailRes = await fetch(`${GHL_API}/contacts/${match.id}`, { headers });
    if (!detailRes.ok) {
      return json(502, { ok: false, error: 'fetch_failed' });
    }
    const detail = await detailRes.json();
    const c = detail.contact || detail;

    let subscriptionMeals = readCustomField(c, CF_SUBSCRIPTION_MEALS_ID);
    if (subscriptionMeals == null || subscriptionMeals === '') {
      subscriptionMeals = readCustomField(c, CF_MEALS_PER_WEEK_ID);
    }

    const n = parseInt(subscriptionMeals, 10);

    // NOTE: ?debug=1 raw-GHL-customField dump REMOVED (it leaked PII on this unauthenticated endpoint).
    return json(200, {
      ok: true,
      contactId: match.id,
      first_name: c.firstName || c.firstNameLowerCase || null,
      subscription_meals: Number.isFinite(n) ? n : null,
    });
  } catch (e) {
    // Don't leak raw exception strings on a public endpoint.
    return json(500, { ok: false, error: 'unexpected' });
  }
};

function readCustomField(contact, fieldId) {
  // GHL v2 contact detail returns customFields as [{id, value}, ...] keyed by field ID.
  const cf = contact.customFields || contact.customField || [];
  if (Array.isArray(cf)) {
    const hit = cf.find((f) => f.id === fieldId);
    return hit ? (hit.value != null ? hit.value : hit.field_value) : null;
  }
  if (typeof cf === 'object' && cf[fieldId] != null) {
    return cf[fieldId];
  }
  return null;
}

function json(status, payload) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
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
