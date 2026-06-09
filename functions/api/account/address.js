// POST /api/account/address — change delivery address / switch pickup↔delivery.
// Body { delivery_method: 'pickup'|'delivery', address?, city?, zip? }. Recomputes the zone from the
// zip and swaps the delivery line item on the Stripe sub (add/update/remove), then updates D1.
// proration_behavior=create_prorations → the fee change takes effect THIS week, prorated (matches the
// customer email's "this week, prorated" copy).
import { ok, fail, readJson } from '../../_lib/respond.js';
import { one, run, nowIso } from '../../_lib/db.js';
import { getSessionCustomer } from '../../_lib/auth.js';
import { stripe } from '../../_lib/stripe.js';
import { str } from '../../_lib/validate.js';
import { currentSub, findItem } from '../../_lib/account.js';
import { ensureDeliveryPrice } from '../../_lib/plans.js';
import { orderableWeek, isLocked } from '../../_lib/menu.js';
import { notify } from '../../_lib/notify.js';

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

  // If this week's order is already locked (or past the Friday cutoff), the fee change applies NEXT cycle
  // (proration=none) so billing matches the meals the kitchen committed with the FROZEN delivery method.
  const weekOf = orderableWeek();
  const order = await one(env.DB, `SELECT status FROM orders WHERE subscription_id = ? AND week_of = ?`, sub.id, weekOf);
  const weekLocked = isLocked(weekOf) || (order && order.status === 'locked');
  const proration = weekLocked ? 'none' : 'create_prorations';

  try {
    const stripeSub = await stripe(env, 'GET', `subscriptions/${sub.stripe_subscription_id}`);
    const deliveryItem = findItem(stripeSub, 'gt_delivery_zone');

    const idemCycle = stripeSub.current_period_start || '';
    if (method === 'delivery' && feeCents > 0) {
      const priceId = await ensureDeliveryPrice(env, zone, feeCents);
      if (deliveryItem) {
        await stripe(env, 'POST', `subscription_items/${deliveryItem.id}`, { price: priceId, quantity: 1, proration_behavior: proration },
          `gt_addr_${deliveryItem.id}_${zone}_${proration}_${idemCycle}`);
      } else {
        await stripe(env, 'POST', 'subscription_items', { subscription: sub.stripe_subscription_id, price: priceId, quantity: 1, proration_behavior: proration },
          `gt_addr_${sub.stripe_subscription_id}_${zone}_${proration}_${idemCycle}`);
      }
    } else if (deliveryItem) {
      // Switching to pickup (or a free zone): drop the delivery line (credit the unused portion if open).
      await stripe(env, 'DELETE', `subscription_items/${deliveryItem.id}`, { proration_behavior: proration });
    }
    // Keep the subscription metadata in step (consistency across Stripe + D1).
    await stripe(env, 'POST', `subscriptions/${sub.stripe_subscription_id}`, { metadata: { delivery_method: method, delivery_zone: String(zone) } });
  } catch (e) {
    return fail(502, 'stripe_failed', String(e?.message || e).slice(0, 160));
  }

  await run(env.DB,
    `UPDATE customers SET delivery_method=?, delivery_zone=?, zip=COALESCE(NULLIF(?,''), zip),
       address=COALESCE(NULLIF(?,''), address), city=COALESCE(NULLIF(?,''), city), updated_at=? WHERE id=?`,
    method, zone, zip, address, city, nowIso(), customer.id);
  try { await notify(env, customer, 'delivery_changed', { method, zone, feeCents, nextWeek: !!weekLocked }); } catch { /* non-fatal */ }
  return ok({ delivery_method: method, delivery_zone: zone, delivery_fee_cents: feeCents, effective: weekLocked ? 'next_week' : 'this_week' });
}
