// GET /api/admin/customers — list customers (with latest sub status + lifetime spend), or
// ?id=<customer> for one customer's full billing view (subscriptions + invoices + payments). This is a
// READ-ONLY view (customer list, meal picks, sub status, invoices/payments) so it's staff-or-owner gated,
// same as kitchen-prep/overview-adjacent reads. The WRITE actions on a customer's account (subscription
// pause/resume/cancel/tier via customer-sub.js, profile/address/password edits via customer-edit.js) stay
// requireOwner — do not loosen those.
import { ok, fail } from '../../_lib/respond.js';
import { requireStaffOrAdmin } from '../../_lib/admin.js';
import { one, all } from '../../_lib/db.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const denied = await requireStaffOrAdmin(context);
  if (denied) return denied;

  const id = new URL(request.url).searchParams.get('id') || '';

  if (id) {
    const customer = await one(env.DB,
      `SELECT id, email, first_name, last_name, phone, delivery_method, delivery_zone, address, city, zip,
              goal, sex, created_at FROM customers WHERE id = ?`, id);
    if (!customer) return fail(404, 'not_found', 'No such customer.');
    const subscriptions = await all(env.DB,
      `SELECT id, stripe_subscription_id, status, meals_per_week, tier_price_cents, coupon_code,
              current_period_end, cancel_at_period_end, created_at FROM subscriptions WHERE customer_id = ? ORDER BY created_at DESC`, id);
    const invoices = await all(env.DB,
      `SELECT id, status, amount_due_cents, amount_paid_cents, discount_cents, hosted_invoice_url, created_at
         FROM invoices WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50`, id);
    const payments = await all(env.DB,
      `SELECT id, amount_cents, status, created_at FROM payments WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50`, id);
    // Meal picks per week (most recent first) + that week's order lock status, so the team can see exactly
    // what someone selected and whether it's locked into the kitchen yet.
    const selections = await all(env.DB,
      `SELECT ms.week_of, ms.meal_position, ms.meal_name, ms.qty
         FROM meal_selections ms
         JOIN subscriptions s ON s.id = ms.subscription_id
        WHERE s.customer_id = ? AND ms.qty > 0
        ORDER BY ms.week_of DESC, ms.meal_position ASC LIMIT 80`, id);
    const orders = await all(env.DB,
      `SELECT week_of, status, total_meals FROM orders WHERE customer_id = ? ORDER BY week_of DESC LIMIT 8`, id);
    // NET lifetime spend = paid invoices + refunds (refund rows are stored negative).
    const spent = await one(env.DB,
      `SELECT COALESCE(SUM(amount_paid_cents),0) AS cents FROM invoices WHERE customer_id = ? AND status = 'paid'`, id);
    const refunded = await one(env.DB,
      `SELECT COALESCE(SUM(amount_cents),0) AS cents FROM payments WHERE customer_id = ? AND status = 'refunded'`, id);
    return ok({ customer, subscriptions, invoices, payments, selections, orders, total_spent_cents: (spent?.cents || 0) + (refunded?.cents || 0) });
  }

  const customers = await all(env.DB,
    `SELECT c.id, c.email, c.first_name, c.last_name, c.delivery_method, c.delivery_zone,
            (SELECT status FROM subscriptions s WHERE s.customer_id = c.id ORDER BY created_at DESC LIMIT 1) AS sub_status,
            (SELECT meals_per_week FROM subscriptions s WHERE s.customer_id = c.id ORDER BY created_at DESC LIMIT 1) AS meals_per_week,
            (SELECT COALESCE(SUM(amount_paid_cents),0) FROM invoices i WHERE i.customer_id = c.id AND i.status = 'paid')
              + (SELECT COALESCE(SUM(amount_cents),0) FROM payments p WHERE p.customer_id = c.id AND p.status = 'refunded') AS spent_cents
       FROM customers c ORDER BY c.created_at DESC LIMIT 500`);
  return ok({ customers, count: customers.length });
}
