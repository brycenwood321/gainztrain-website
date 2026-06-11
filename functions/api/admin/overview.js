// GET /api/admin/overview — the ops dashboard summary. Admin-gated.
// One round of cheap aggregates: subscription mix, this week's locked production, delivery/pickup split,
// weekly recurring meal revenue, 30-day paid revenue, and two health signals (failed comms, stuck webhooks).
import { ok, fail } from '../../_lib/respond.js';
import { requireStaffOrAdmin } from '../../_lib/admin.js';
import { one, all, addDaysIso } from '../../_lib/db.js';
import { upcomingSunday } from '../../_lib/menu.js';

const ACTIVE = ['active', 'trialing', 'past_due']; // headcount/production set (past_due still gets meals)
const BILLING = ['active', 'trialing'];            // revenue set — past_due isn't being collected

export async function onRequestGet(context) {
  const { request, env } = context;
  const denied = await requireStaffOrAdmin(context);
  if (denied) return denied;

  const week = new URL(request.url).searchParams.get('week_of') || upcomingSunday();
  const inActive = ACTIVE.map(() => '?').join(',');

  const byStatus = await all(env.DB, `SELECT status, COUNT(*) AS n FROM subscriptions GROUP BY status`);
  const activeCount = byStatus.filter((r) => ACTIVE.includes(r.status)).reduce((s, r) => s + r.n, 0);

  const prod = await one(env.DB,
    `SELECT COUNT(*) AS orders, COALESCE(SUM(total_meals),0) AS meals,
            COALESCE(SUM(upcharge_total_cents),0) AS upcharge_cents
       FROM orders WHERE week_of = ? AND status = 'locked'`, week);

  // COUNT(DISTINCT c.id) so a customer with two subs counts once.
  const split = await all(env.DB,
    `SELECT c.delivery_method AS method, COUNT(DISTINCT c.id) AS n
       FROM subscriptions s JOIN customers c ON c.id = s.customer_id
      WHERE s.status IN (${inActive}) GROUP BY c.delivery_method`, ...ACTIVE);

  // Weekly LIST price (pre-discount, billing set only). Coupons aren't applied here — labeled as such.
  const inBilling = BILLING.map(() => '?').join(',');
  const wrr = await one(env.DB,
    `SELECT COALESCE(SUM(meals_per_week * tier_price_cents),0) AS cents
       FROM subscriptions WHERE status IN (${inBilling})`, ...BILLING);

  // NET 30-day revenue = paid invoices MINUS refunds. Refund rows are stored NEGATIVE (mirror.js), so
  // adding them nets correctly. Without this the dashboard silently overstates revenue.
  const rev30 = await one(env.DB,
    `SELECT COALESCE(SUM(amount_paid_cents),0) AS cents FROM invoices WHERE status = 'paid' AND created_at >= ?`,
    addDaysIso(-30));
  const refunds30 = await one(env.DB,
    `SELECT COALESCE(SUM(amount_cents),0) AS cents FROM payments WHERE status = 'refunded' AND created_at >= ?`,
    addDaysIso(-30));

  const failedComms = await one(env.DB,
    `SELECT COUNT(*) AS n FROM comms_log WHERE ghl_status = 'failed' AND sent_at >= ?`, addDaysIso(-1));
  const stuckWebhooks = await one(env.DB,
    `SELECT COUNT(*) AS n FROM stripe_events WHERE processed_at IS NULL`);

  return ok({
    week_of: week,
    subscriptions: { active: activeCount, by_status: byStatus },
    production: { orders: prod?.orders || 0, meals: prod?.meals || 0, upcharge_cents: prod?.upcharge_cents || 0 },
    delivery_split: split,
    weekly_list_price_cents: wrr?.cents || 0, // pre-discount list price (billing set)
    revenue_30d_cents: (rev30?.cents || 0) + (refunds30?.cents || 0), // NET of refunds
    refunds_30d_cents: refunds30?.cents || 0,
    health: { failed_comms_24h: failedComms?.n || 0, stuck_webhooks: stuckWebhooks?.n || 0 },
  });
}
