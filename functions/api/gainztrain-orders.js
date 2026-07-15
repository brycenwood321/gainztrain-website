// GET /api/gainztrain-orders?week=YYYY-MM-DD&token=SECRET
// Read-only feed of a single prep week's cookable orders for the Sunday meal-prep assembly dashboard
// (a separate browser-only app, no backend). Designed to be fetched cross-origin.
//
// ⚠️ FROZEN CONTRACT — LIVE IN PRODUCTION (the Sunday prep dashboard prints labels + draws the delivery
// map from this). DO NOT change the following without telling MARISSA first, or the dashboard breaks
// SILENTLY (no error, wrong labels or a blank map):
//   • the path /api/gainztrain-orders
//   • any JSON field name (week_of, orders, customer_id, first_name, last_name, gender, goal,
//     fulfillment, address, meals, meal_name, quantity)
//   • the allowed values: gender = "F"|"M"; goal = "Cut"|"Maintain"|"Bulk"; fulfillment = "delivery"|"pickup"
//   • the Access-Control-Allow-Origin header (removing it = browser CORS-blocks ALL orders)
//   • the KITCHEN_FEED_TOKEN (if rotating, give Marissa the NEW token BEFORE killing the old one)
//   • address: full street address for delivery, and null (NOT "") for pickup — partial = geocode fails
// Safe to change freely: new meal names, new customers, internal DB structure (as long as this JSON
// shape is unchanged). See memory project_gt_orders_api_contract_2026-06-27.
//
// AUTH: a DEDICATED secret (env.KITCHEN_FEED_TOKEN), NOT the master ADMIN_TOKEN. This is deliberate —
// a client-side app must embed its token in JS where anyone who loads the app can read it, so this
// token can ONLY read one week's order list. It can never mutate billing, lock weeks, or touch any
// other endpoint. Rotate it any time with `wrangler pages secret put KITCHEN_FEED_TOKEN`.
// Accepts the token via ?token= (as the dashboard sends it) or an x-kitchen-token header.
//
// CORS: Access-Control-Allow-Origin defaults to * so the browser app can fetch directly. Set
// env.KITCHEN_FEED_ORIGIN to the dashboard's exact origin (e.g. https://prep.gainztrainprep.com) to
// lock CORS to just that site instead of * — strictly safer once the dashboard URL is known.
//
// SHAPE (contract owned by the prep dashboard team):
//   { week_of, orders: [ { customer_id, first_name, last_name, gender, goal, fulfillment, address,
//                          meals: [ { meal_name, quantity } ] } ] }
//   gender      → "F" | "M"
//   goal        → "Cut" | "Maintain" | "Bulk"
//   fulfillment → "delivery" | "pickup"
//   address     → full "Street, City, UT Zip" for delivery; null for pickup
//   week_of     → the Sunday (YYYY-MM-DD)
import { json, fail } from '../_lib/respond.js';
import { all } from '../_lib/db.js';
import { upcomingSunday } from '../_lib/menu.js';
import { sha256hex, constantTimeEqual } from '../_lib/crypto.js';

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.KITCHEN_FEED_ORIGIN || 'https://gainztrainprep.com',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'x-kitchen-token, content-type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

// Browser preflight (only fires if the app sends the header variant; harmless to always answer).
export function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.env) });
}

// Our stored value → the contract's required value. Unknown/NULL falls back to a documented default
// (the shape demands a non-null F/M and Cut/Maintain/Bulk) — these are flagged for the prep team.
function mapGender(sex) {
  return String(sex || '').toLowerCase() === 'female' ? 'F' : 'M'; // default M when unset
}
function mapGoal(goal) {
  switch (String(goal || '').toLowerCase()) {
    case 'cut': return 'Cut';
    case 'build': return 'Bulk';     // our DB stores 'build'; the contract calls it 'Bulk'
    case 'maintain': return 'Maintain';
    default: return 'Maintain';      // default when unset
  }
}
// Street, City, UT Zip — Google-Maps ready. null for pickup or when we have no street on file.
function buildAddress(fulfillment, address, city, zip) {
  if (fulfillment !== 'delivery') return null;
  const street = String(address || '').trim();
  if (!street) return null;
  const parts = [street];
  const c = String(city || '').trim();
  const z = String(zip || '').trim();
  if (c) parts.push(c);
  parts.push(z ? `UT ${z}` : 'UT'); // every served zip is Utah County; no state column in the schema
  return parts.join(', ');
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const cors = corsHeaders(env);

  // ── Auth: dedicated kitchen token, constant-time compared (hash both → no length/timing oracle). ──
  const url = new URL(request.url);
  const provided = url.searchParams.get('token') || request.headers.get('x-kitchen-token') || '';
  const expected = env.KITCHEN_FEED_TOKEN || '';
  if (!expected) return fail(503, 'not_configured', 'Kitchen feed token is not set on the server.');
  const [a, b] = await Promise.all([sha256hex(provided), sha256hex(expected)]);
  if (!provided || !constantTimeEqual(a, b)) {
    return json({ ok: false, error: 'unauthorized', detail: 'Missing or incorrect token.' }, 401, cors);
  }

  // ── Week: ?week=YYYY-MM-DD, else default to the current/upcoming Sunday. ──
  const weekParam = url.searchParams.get('week');
  if (weekParam && !WEEK_RE.test(weekParam)) {
    return json({ ok: false, error: 'bad_week', detail: 'week must be YYYY-MM-DD.' }, 400, cors);
  }
  const week = weekParam || upcomingSunday();

  // One row per (order × selected meal) for the week — exactly the cook-list join used by
  // /api/admin/kitchen-prep. Excludes paused/canceled orders and empty (qty=0) picks. delivery_method
  // is COALESCEd to the frozen order value (falls back to the customer's live method for pre-snapshot
  // orders). customer_id is our stable uuid.
  const rows = await all(env.DB,
    `SELECT o.customer_id,
            c.first_name, c.last_name, c.goal, c.sex, c.address, c.city, c.zip,
            COALESCE(o.delivery_method, c.delivery_method) AS fulfillment,
            ms.meal_position, ms.meal_name, ms.qty
       FROM meal_selections ms
       JOIN orders   o ON o.subscription_id = ms.subscription_id AND o.week_of = ms.week_of
       JOIN customers c ON c.id = o.customer_id
      WHERE ms.week_of = ?
        AND ms.qty > 0
        AND o.status NOT IN ('skipped_paused','skipped_canceled')
      ORDER BY c.last_name, c.first_name, ms.meal_position`,
    week);

  // Group the flat rows into one order object per customer.
  const byCustomer = new Map();
  for (const r of rows) {
    let entry = byCustomer.get(r.customer_id);
    if (!entry) {
      const fulfillment = r.fulfillment === 'delivery' ? 'delivery' : 'pickup';
      entry = {
        customer_id: r.customer_id,
        first_name: r.first_name || '',
        last_name: r.last_name || '',
        gender: mapGender(r.sex),
        goal: mapGoal(r.goal),
        fulfillment,
        address: buildAddress(fulfillment, r.address, r.city, r.zip),
        meals: [],
      };
      byCustomer.set(r.customer_id, entry);
    }
    entry.meals.push({ meal_name: r.meal_name, quantity: r.qty });
  }

  return json({ week_of: week, orders: [...byCustomer.values()] }, 200, cors);
}
