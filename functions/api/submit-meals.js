// POST /api/submit-meals
// Body: { email, name, phone, meal_1, meal_2, meal_3, meal_4 }
//
// Looks up the GHL contact by email, updates their meal_X_count custom fields,
// and adds the `meal-selection-submitted` tag. The GT - Meal Selection
// Confirmation workflow should trigger on that tag added (re-trigger every time).

const GHL_API = 'https://services.leadconnectorhq.com';
const GHL_LOCATION = 'tyF96Dl8uAXn5ZD5tZ3p';

// Custom field IDs from the existing weekly_menu.html that's already wired up
const CF_MEAL_1 = '4RBRbxwC7DlTZQLZS6eq';
const CF_MEAL_2 = 'fCeBeqOGkM2fPF1WPiou';
const CF_MEAL_3 = '0KXO0jv2W62TtHpxn1GI';
const CF_MEAL_4 = 'EmQSbCzexeMpp8lwHDrM';

const SUBMITTED_TAG = 'meal-selection-submitted';

async function mainLogic(event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'method_not_allowed' });
  }

  const token = process.env.GAINZ_GHL_TOKEN;
  if (!token) {
    return json(500, { ok: false, error: 'token_not_configured' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { ok: false, error: 'bad_json' });
  }

  const email = (body.email || '').trim().toLowerCase();
  const name = (body.name || '').trim();
  const phone = (body.phone || '').trim();
  const m1 = clampInt(body.meal_1);
  const m2 = clampInt(body.meal_2);
  const m3 = clampInt(body.meal_3);
  const m4 = clampInt(body.meal_4);

  if (!email) return json(400, { ok: false, error: 'email_required' });
  if (m1 + m2 + m3 + m4 === 0) return json(400, { ok: false, error: 'no_meals_selected' });

  const headers = {
    Authorization: `Bearer ${token}`,
    Version: '2021-07-28',
    'Content-Type': 'application/json',
  };

  try {
    // 1. Find contact by email (preferred over phone — email is unique in GHL)
    const searchUrl = `${GHL_API}/contacts/?locationId=${GHL_LOCATION}&query=${encodeURIComponent(email)}&limit=5`;
    const searchRes = await fetch(searchUrl, { headers });
    if (!searchRes.ok) {
      const txt = await searchRes.text();
      return json(502, { ok: false, error: 'search_failed', detail: txt.slice(0, 200) });
    }
    const searchData = await searchRes.json();
    const contacts = searchData.contacts || [];
    // Match by exact email since query is fuzzy
    const match = contacts.find((c) => (c.email || '').toLowerCase() === email);
    if (!match) {
      return json(404, { ok: false, error: 'contact_not_found' });
    }
    const contactId = match.id;

    // 2. Update meal count custom fields
    const updateRes = await fetch(`${GHL_API}/contacts/${contactId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        customFields: [
          { id: CF_MEAL_1, field_value: m1 },
          { id: CF_MEAL_2, field_value: m2 },
          { id: CF_MEAL_3, field_value: m3 },
          { id: CF_MEAL_4, field_value: m4 },
        ],
      }),
    });
    if (!updateRes.ok) {
      const txt = await updateRes.text();
      return json(502, { ok: false, error: 'update_failed', detail: txt.slice(0, 200) });
    }

    // 3. Add the tag (idempotent on the GHL side)
    const tagRes = await fetch(`${GHL_API}/contacts/${contactId}/tags`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tags: [SUBMITTED_TAG] }),
    });
    if (!tagRes.ok) {
      // Non-fatal: we updated the fields, just log the tag failure
      const txt = await tagRes.text();
      return json(200, {
        ok: true,
        warning: 'tag_failed',
        detail: txt.slice(0, 200),
        contactId,
      });
    }

    return json(200, { ok: true, contactId });
  } catch (e) {
    return json(500, { ok: false, error: 'unexpected', detail: String(e).slice(0, 200) });
  }
};

function clampInt(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(20, n);
}

function json(status, payload) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
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
