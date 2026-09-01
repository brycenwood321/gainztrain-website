// POST /api/admin/customer-edit — OWNER-only edit of a customer's profile from the /ops Customers tab:
// name, phone, a password reset, and/or delivery address. Address changes recompute the zone from the
// zip and swap the Stripe delivery line (same logic as the customer's own /api/account/address), so the
// delivery fee stays correct. Every field is optional — send only what you're changing. Owner-gated.
//   Body { customer_id, first_name?, last_name?, phone?, password?,
//          address_change?: { delivery_method, address?, city?, zip? } }
import { ok, fail, readJson } from '../../_lib/respond.js';
import { one, run, nowIso } from '../../_lib/db.js';
import { requireOwner } from '../../_lib/admin.js';
import { getSessionCustomer } from '../../_lib/auth.js';
import { stripe } from '../../_lib/stripe.js';
import { str, toE164 } from '../../_lib/validate.js';
import { hashPassword } from '../../_lib/crypto.js';
import { currentSub, findItem } from '../../_lib/account.js';
import { ensureDeliveryPrice } from '../../_lib/plans.js';
import { orderableWeek, isLocked } from '../../_lib/menu.js';
import { ownerNotify } from '../../_lib/owner_notify.js';
import { notify } from '../../_lib/notify.js';
import { ghlUpdatePhone } from '../../_lib/ghl.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const denied = await requireOwner(context);
  if (denied) return denied;

  const body = await readJson(request);
  const customerId = str(body.customer_id);
  if (!customerId) return fail(400, 'no_customer', 'customer_id is required.');
  const customer = await one(env.DB, `SELECT * FROM customers WHERE id = ?`, customerId);
  if (!customer) return fail(404, 'not_found', 'Customer not found.');

  let actor = 'admin-token';
  try { const s = await getSessionCustomer(context); if (s) actor = s.customer.email || s.customer.id; } catch { /* token */ }

  const changed = [];
  const now = nowIso();

  // ── 1. Profile fields (name / phone) — plain D1, no Stripe ──
  const firstName = body.first_name !== undefined ? str(body.first_name).trim().slice(0, 80) : null;
  const lastName  = body.last_name  !== undefined ? str(body.last_name).trim().slice(0, 80)  : null;
  let phone = null;
  if (body.phone !== undefined) {
    const raw = str(body.phone).trim();
    if (raw) { phone = toE164(raw); if (!phone) return fail(400, 'invalid_phone', 'Enter a valid phone number.'); }
    else phone = '';
  }
  if (firstName !== null || lastName !== null || phone !== null) {
    await run(env.DB,
      `UPDATE customers SET
         first_name = COALESCE(?, first_name),
         last_name  = COALESCE(?, last_name),
         phone      = CASE WHEN ? IS NULL THEN phone WHEN ? = '' THEN NULL ELSE ? END,
         updated_at = ? WHERE id = ?`,
      firstName, lastName, phone, phone, phone, now, customerId);
    if (firstName !== null || lastName !== null) changed.push('name');
    if (phone !== null) changed.push('phone');
    // Keep GHL's copy of the phone in step at the moment it changes. D1 alone is not enough:
    // GHL is the thing that actually dials, and a contact that never learns the number fails
    // every text as "no phone on file" (4 of 20 customers on 2026-08-30). Best-effort; the
    // Saturday phone-sync sweep catches anything this misses.
    if (phone && customer.ghl_contact_id) {
      try { await ghlUpdatePhone(env, customer.ghl_contact_id, phone); } catch { /* sweep catches it */ }
    }
  }

  // ── 2. Password reset ──
  if (body.password !== undefined && str(body.password) !== '') {
    const pw = str(body.password);
    if (pw.length < 8) return fail(400, 'weak_password', 'Password must be at least 8 characters.');
    const { hash, salt, iterations } = await hashPassword(pw);
    await run(env.DB,
      `INSERT INTO auth_passwords (customer_id, password_hash, salt, iterations, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(customer_id) DO UPDATE SET password_hash=excluded.password_hash,
         salt=excluded.salt, iterations=excluded.iterations, updated_at=excluded.updated_at`,
      customerId, hash, salt, iterations, now);
    // Invalidate existing sessions so an old/compromised login can't persist after a reset.
    try { await run(env.DB, `DELETE FROM sessions WHERE customer_id = ?`, customerId); } catch { /* non-fatal */ }
    changed.push('password');
  }

  // ── 3. Delivery address (recompute zone + sync Stripe delivery line) ──
  const ac = body.address_change;
  let addrResult = null;
  // Hoisted so the customer's notice can state the SAME timing the proration actually used — "this
  // week, prorated" vs "from next week". Computed inside the Stripe branch below.
  let addrWeekLocked = false;
  if (ac && typeof ac === 'object') {
    const method = str(ac.delivery_method) === 'delivery' ? 'delivery' : 'pickup';
    let zone = 0, feeCents = 0, zip = '', address = '', city = '';
    if (method === 'delivery') {
      zip = str(ac.zip).replace(/[^0-9]/g, '').slice(0, 5);
      address = str(ac.address).trim().slice(0, 200);
      city = str(ac.city).trim().slice(0, 80);
      if (!zip || zip.length !== 5 || !address) return fail(400, 'address_required', 'Enter a delivery address and a valid 5-digit zip.');
      const z = await one(env.DB, `SELECT zone FROM zip_zone_map WHERE zip = ?`, zip);
      if (!z) return fail(400, 'zip_not_served', "We don't deliver to that zip yet.");
      zone = z.zone;
      const dz = await one(env.DB, `SELECT fee_cents FROM delivery_zones WHERE zone = ?`, zone);
      if (!dz) return fail(500, 'zone_misconfigured', 'That delivery zone is not configured.');
      feeCents = dz.fee_cents ?? 0;
    }

    const sub = await currentSub(env, customerId, ['active', 'trialing', 'past_due', 'paused']);
    // Address on a customer without an active sub → update D1 only (no Stripe line to sync).
    if (sub && sub.stripe_subscription_id) {
      const weekOf = orderableWeek();
      const order = await one(env.DB, `SELECT status FROM orders WHERE subscription_id = ? AND week_of = ?`, sub.id, weekOf);
      const weekLocked = isLocked(weekOf) || (order && order.status === 'locked');
      addrWeekLocked = !!weekLocked;
      const proration = weekLocked ? 'none' : 'create_prorations';
      try {
        const stripeSub = await stripe(env, 'GET', `subscriptions/${sub.stripe_subscription_id}`);
        const deliveryItem = findItem(stripeSub, 'gt_delivery_zone');
        const idemCycle = stripeSub.current_period_start || '';
        if (method === 'delivery' && feeCents > 0) {
          const priceId = await ensureDeliveryPrice(env, zone, feeCents);
          if (deliveryItem) {
            await stripe(env, 'POST', `subscription_items/${deliveryItem.id}`, { price: priceId, quantity: 1, proration_behavior: proration }, `gt_admaddr_${deliveryItem.id}_${zone}_${proration}_${idemCycle}`);
          } else {
            await stripe(env, 'POST', 'subscription_items', { subscription: sub.stripe_subscription_id, price: priceId, quantity: 1, proration_behavior: proration }, `gt_admaddr_${sub.stripe_subscription_id}_${zone}_${proration}_${idemCycle}`);
          }
        } else if (deliveryItem) {
          await stripe(env, 'DELETE', `subscription_items/${deliveryItem.id}`, { proration_behavior: proration });
        }
        await stripe(env, 'POST', `subscriptions/${sub.stripe_subscription_id}`, { metadata: { delivery_method: method, delivery_zone: String(zone) } });
      } catch (e) {
        return fail(502, 'stripe_failed', String(e?.message || e).slice(0, 200));
      }
    }

    await run(env.DB,
      `UPDATE customers SET delivery_method=?, delivery_zone=?, zip=COALESCE(NULLIF(?,''), zip),
         address=COALESCE(NULLIF(?,''), address), city=COALESCE(NULLIF(?,''), city), updated_at=? WHERE id=?`,
      method, zone, zip, address, city, now, customerId);
    addrResult = { delivery_method: method, delivery_zone: zone, delivery_fee_cents: feeCents };
    changed.push('address');
  }

  if (!changed.length) return fail(400, 'nothing_to_change', 'No fields provided to update.');

  try { await run(env.DB, `INSERT INTO audit_log (at, actor, entity, action, detail_json) VALUES (?, ?, ?, 'admin_edit_customer', ?)`,
    now, actor, `customer:${customerId}`, JSON.stringify({ changed })); } catch { /* non-fatal */ }
  try { await ownerNotify(env, 'owner_edit_customer', `${customer.first_name || customer.email} edited (${changed.join(', ')}) — by ${actor}`, { entity: `customer:${customerId}` }); } catch { /* non-fatal */ }

  // Tell the CUSTOMER when staff changed their delivery, exactly as api/account/address.js does when
  // they change it themselves. This path recomputes their zone AND swaps the Stripe delivery line, so
  // it changes what they pay every week — and it used to say nothing at all. The asymmetry was the bug:
  // the same change was announced when the customer made it and silent when we did.
  // Password resets are deliberately NOT announced here: set-password.js already owns that notice, and
  // an owner resetting a password is usually doing it WITH the customer on the phone.
  if (addrResult) {
    try {
      await notify(env, customer, 'delivery_changed', {
        method: addrResult.delivery_method,
        zone: addrResult.delivery_zone,
        feeCents: addrResult.delivery_fee_cents,
        nextWeek: addrWeekLocked,
      });
    } catch { /* non-fatal */ }
  }

  return ok({ changed, address: addrResult });
}
