// POST /api/account/address — change delivery address / switch pickup↔delivery.
// Body { delivery_method: 'pickup'|'delivery', address?, city?, zip? }. Recomputes the zone from the
// zip and swaps the delivery line item on the Stripe sub (add/update/remove), then updates D1.
// proration_behavior=none → fee change starts next cycle.
import { ok, fail, readJson } from '../../_lib/respond.js';
import { one, run, nowIso } from '../../_lib/db.js';
import { getSessionCustomer } from '../../_lib/auth.js';
import { stripe } from '../../_lib/stripe.js';
import { str } from '../../_lib/validate.js';
import { currentSub, findItem } from '../../_lib/account.js';
import { ensureDeliveryPrice } from '../../_lib/plans.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = await getSessionCustomer(context);
  if (!auth) return fail(401, 'not_authenticated', 'Please log in.');
  const { customer } = auth;

  const body = await readJson(request);
  const method = str(body.delivery_method) === 'delivery' ? 'delivery' : 'pickup';
  let zone = 0, feeCents = 0, zip = '', address = '', city = '';
  if (method === 'delivery') {
    zip = str(body.zip).replace(/[^0-9]/g, '').slice(0, 5);
    address = str(body.address).trim().slice(0, 200);
    city = str(body.city).trim().slice(0, 80);
    if (!zip || zip.length !== 5 || !address) return fail(400, 'address_required', 'Enter your delivery address and a valid zip.');
    const z = await one(env.DB, `SELECT zone FROM zip_zone_map WHERE zip = ?`, zip);
    if (!z) return fail(400, 'zip_not_served', "We don't deliver to that zip yet — choose pickup, or contact us.");
    zone = z.zone;
    const dz = await one(env.DB, `SELECT fee_cents FROM delivery_zones WHERE zone = ?`, zone);
    if (!dz) return fail(500, 'zone_misconfigured', 'Delivery for your area is being set up — choose pickup for now.');
    feeCents = dz.fee_cents ?? 0;
  }

  const sub = await currentSub(env, customer.id, ['active', 'trialing', 'past_due', 'paused']);
  if (!sub || !sub.stripe_subscription_id) return fail(400, 'no_active_sub', 'You have no active plan to change.');

  try {
    const stripeSub = await stripe(env, 'GET', `subscriptions/${sub.stripe_subscription_id}`);
    const deliveryItem = findItem(stripeSub, 'gt_delivery_zone');

    if (method === 'delivery' && feeCents > 0) {
      const priceId = await ensureDeliveryPrice(env, zone, feeCents);
      if (deliveryItem) {
        await stripe(env, 'POST', `subscription_items/${deliveryItem.id}`, { price: priceId, quantity: 1, proration_behavior: 'none' });
      } else {
        await stripe(env, 'POST', 'subscription_items', { subscription: sub.stripe_subscription_id, price: priceId, quantity: 1, proration_behavior: 'none' });
      }
    } else if (deliveryItem) {
      // Switching to pickup (or a free zone): drop the delivery line.
      await stripe(env, 'DELETE', `subscription_items/${deliveryItem.id}`, { proration_behavior: 'none' });
    }
  } catch (e) {
    return fail(502, 'stripe_failed', String(e?.message || e).slice(0, 160));
  }

  await run(env.DB,
    `UPDATE customers SET delivery_method=?, delivery_zone=?, zip=COALESCE(NULLIF(?,''), zip),
       address=COALESCE(NULLIF(?,''), address), city=COALESCE(NULLIF(?,''), city), updated_at=? WHERE id=?`,
    method, zone, zip, address, city, nowIso(), customer.id);
  return ok({ delivery_method: method, delivery_zone: zone, delivery_fee_cents: feeCents });
}
