// GET /api/admin/route?week_of=YYYY-MM-DD — the delivery run for a week: every LOCKED delivery order
// with its address, grouped by zone (nearest-first), with the per-stop meal count + live delivery
// status. Admin-gated. This is the driver's list / the delivery location map source.
import { ok, fail } from '../../_lib/respond.js';
import { requireStaffOrAdmin } from '../../_lib/admin.js';
import { all } from '../../_lib/db.js';
import { upcomingSunday } from '../../_lib/menu.js';

// Kitchen origin (Orem). Used as the start point for both the nearest-neighbor ordering and the Maps URL.
const KITCHEN = { lat: 40.2969, lng: -111.6946 };

// Squared planar distance is fine for ordering at county scale (no need for haversine precision).
function dist2(a, b) { const dx = a.lat - b.lat, dy = a.lng - b.lng; return dx * dx + dy * dy; }

// Greedy nearest-neighbor from the kitchen. Stops missing coords can't be ordered → returned separately.
function orderStops(stops) {
  const geo = stops.filter((s) => s.lat != null && s.lng != null);
  const noGeo = stops.filter((s) => s.lat == null || s.lng == null);
  const remaining = geo.slice();
  const ordered = [];
  let cur = KITCHEN;
  while (remaining.length) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < remaining.length; i++) { const d = dist2(cur, remaining[i]); if (d < bd) { bd = d; bi = i; } }
    const next = remaining.splice(bi, 1)[0];
    ordered.push(next); cur = next;
  }
  return { ordered, noGeo };
}

// Google Maps multi-stop directions URL (no API key; opens native maps on phones). Cap stops so the URL
// stays well under length limits — beyond ~10 stops a single run isn't realistic anyway.
function mapsUrl(ordered) {
  if (!ordered.length) return null;
  const pt = (s) => `${s.lat},${s.lng}`;
  const stops = ordered.slice(0, 10).map(pt);
  return `https://www.google.com/maps/dir/${KITCHEN.lat},${KITCHEN.lng}/${stops.join('/')}`;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const denied = await requireStaffOrAdmin(context);
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

  // Optimized drive order from the kitchen + a one-tap Google Maps route.
  const { ordered, noGeo } = orderStops(stops);
  const route = ordered.map((s, i) => ({ ...s, stop_order: i + 1 }));

  return ok({
    week_of: week,
    total_stops: stops.length,
    total_meals: stops.reduce((s, x) => s + (x.total_meals || 0), 0),
    zones,
    route,                         // flat, nearest-neighbor ordered from the Orem kitchen
    maps_url: mapsUrl(ordered),    // one-tap multi-stop Google Maps directions (first 10 stops)
    geocode_missing: noGeo.map((s) => ({ order_id: s.order_id, name: `${s.first_name || ''} ${s.last_name || ''}`.trim(), zip: s.zip })),
  });
}
