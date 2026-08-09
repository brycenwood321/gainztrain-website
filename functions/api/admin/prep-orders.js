// GET /api/admin/prep-orders?week=YYYY-MM-DD
// Staff-session (or admin-token) gated twin of the public /api/gainztrain-orders feed. Returns the
// EXACT same JSON shape, but authorized by a logged-in staff member's session cookie instead of an
// embedded secret token. This is what the HOSTED prep dashboard (/app/ops/prep/) calls, so the
// dashboard's HTML never has to carry a readable token. The public /api/gainztrain-orders endpoint is
// left untouched (frozen contract) for any out-of-app/cross-origin use.
//
// Shape (must stay identical to gainztrain-orders.js — same prep dashboard reads both):
//   { week_of, orders: [ { customer_id, first_name, last_name, gender, goal, fulfillment, address,
//                          meals: [ { meal_name, quantity } ] } ] }
//   gender → "F"|"M"   goal → "Cut"|"Maintain"|"Bulk"   fulfillment → "delivery"|"pickup"
import { json } from '../../_lib/respond.js';
import { all } from '../../_lib/db.js';
import { upcomingSunday } from '../../_lib/menu.js';
import { requireStaffOrAdmin } from '../../_lib/admin.js';

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;

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
function buildAddress(fulfillment, address, city, zip) {
  if (fulfillment !== 'delivery') return null;
  const street = String(address || '').trim();
  if (!street) return null;
  const parts = [street];
  const c = String(city || '').trim();
  const z = String(zip || '').trim();
  if (c) parts.push(c);
  parts.push(z ? `UT ${z}` : 'UT');
  return parts.join(', ');
}

export async function onRequestGet(context) {
  const { request, env } = context;

  // ── Auth: logged-in staff member OR the admin token. No embedded secret in the client. ──
  const denied = await requireStaffOrAdmin(context);
  if (denied) return denied;

  const url = new URL(request.url);
  const weekParam = url.searchParams.get('week');
  if (weekParam && !WEEK_RE.test(weekParam)) {
    return json({ ok: false, error: 'bad_week', detail: 'week must be YYYY-MM-DD.' }, 400);
  }
  const week = weekParam || upcomingSunday();

  // Same cook-list join as /api/gainztrain-orders + /api/admin/kitchen-prep.
  const rows = await all(env.DB,
    // o.id + o.delivery_status ride along so the Assembly scanner can tell /api/admin/delivery-status
    // WHICH order just finished packing, and can skip anyone already notified.
    `SELECT o.customer_id, o.id AS order_id, o.delivery_status,
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

  const byCustomer = new Map();
  for (const r of rows) {
    let entry = byCustomer.get(r.customer_id);
    if (!entry) {
      const fulfillment = r.fulfillment === 'delivery' ? 'delivery' : 'pickup';
      entry = {
        customer_id: r.customer_id,
        order_id: r.order_id,
        delivery_status: r.delivery_status || 'scheduled',
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

  return json({ week_of: week, orders: [...byCustomer.values()] }, 200);
}
