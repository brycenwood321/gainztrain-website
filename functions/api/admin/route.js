// GET /api/admin/route?week_of=YYYY-MM-DD — the delivery run for a week: every LOCKED delivery order
// with its address, grouped by zone (nearest-first), with the per-stop meal count + live delivery
// status. Admin-gated. This is the driver's list / the delivery location map source.
import { ok, fail } from '../../_lib/respond.js';
import { requireAdmin } from '../../_lib/admin.js';
import { all } from '../../_lib/db.js';
import { upcomingSunday } from '../../_lib/menu.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const denied = await requireAdmin(context);
  if (denied) return denied;

  const week = new URL(request.url).searchParams.get('week_of') || upcomingSunday();

  const stops = await all(env.DB,
    `SELECT o.id AS order_id, o.total_meals, o.delivery_status, o.tracking_token,
            c.first_name, c.last_name, c.phone, c.address, c.city, c.zip,
            c.delivery_zone AS zone, c.lat, c.lng
       FROM orders o JOIN customers c ON c.id = o.customer_id
      WHERE o.week_of = ? AND o.status = 'locked' AND COALESCE(o.delivery_method, c.delivery_method) = 'delivery'
      ORDER BY c.delivery_zone, c.zip, c.last_name`, week);

  // Group by zone for the run sheet.
  const byZone = {};
  for (const s of stops) {
    const z = s.zone ?? 0;
    (byZone[z] = byZone[z] || []).push(s);
  }
  const zones = Object.keys(byZone).map(Number).sort((a, b) => a - b)
    .map((z) => ({ zone: z, stops: byZone[z], stop_count: byZone[z].length,
      meals: byZone[z].reduce((s, x) => s + (x.total_meals || 0), 0) }));

  return ok({
    week_of: week,
    total_stops: stops.length,
    total_meals: stops.reduce((s, x) => s + (x.total_meals || 0), 0),
    zones,
  });
}
