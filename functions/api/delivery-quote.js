// GET /api/delivery-quote?zip=84601 — public, read-only. Returns whether we serve a zip and the
// Sunday delivery fee for its zone, so /start can show the REAL weekly total (meals + delivery)
// BEFORE checkout instead of surprising the customer at Stripe. No PII, no mutation. Rate-limited.
import { ok, fail } from '../_lib/respond.js';
import { one } from '../_lib/db.js';
import { rateLimit, clientIp } from '../_lib/ratelimit.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const zip = (new URL(request.url).searchParams.get('zip') || '').replace(/[^0-9]/g, '').slice(0, 5);
  if (zip.length !== 5) return fail(400, 'zip_required', 'Enter a 5-digit zip.');
  // Bound abuse; on limit return served:null so /start degrades to the existing checkout-time validation.
  if (!(await rateLimit(env, `dquote:ip:${clientIp(request)}`, 40, 600))) return ok({ served: null });
  const z = await one(env.DB, `SELECT zone FROM zip_zone_map WHERE zip = ?`, zip);
  if (!z) return ok({ served: false, zip });
  const dz = await one(env.DB, `SELECT name, fee_cents FROM delivery_zones WHERE zone = ?`, z.zone);
  return ok({ served: true, zip, zone: z.zone, fee_cents: dz?.fee_cents ?? 0, zone_name: dz?.name || `Zone ${z.zone}` });
}
