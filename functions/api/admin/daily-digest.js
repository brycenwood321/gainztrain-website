// POST /api/admin/daily-digest — the owner's morning summary + health probe. Admin-gated; called by the
// cron Worker ~7am MT. Aggregates the last 24h of activity, the key business numbers, and two health
// signals, then hands them to ownerNotify() (which emails the owners if OWNER_NOTIFY_ENABLED='true').
// If a health signal trips, it ALSO fires an instant owner_health_alert so a silent failure can't hide.
import { ok } from '../../_lib/respond.js';
import { requireAdmin } from '../../_lib/admin.js';
import { one, all, addDaysIso } from '../../_lib/db.js';
import { upcomingSunday, orderableWeek } from '../../_lib/menu.js';
import { ownerNotify } from '../../_lib/owner_notify.js';

const ACTIVE = ['active', 'trialing', 'past_due'];
const BILLING = ['active', 'trialing'];
const money = (c) => '$' + ((c || 0) / 100).toFixed(2);

export async function onRequestPost(context) {
  const { env } = context;
  const denied = await requireAdmin(context);
  if (denied) return denied;

  const since = addDaysIso(-1);
  const week = upcomingSunday();

  // Last-24h customer activity, grouped (owner_* rows carry the human summaries).
  const activity = await all(env.DB,
    `SELECT action, COUNT(*) AS n FROM audit_log WHERE at >= ? AND actor = 'owner' GROUP BY action ORDER BY n DESC`, since);
  const recent = await all(env.DB,
    `SELECT detail_json FROM audit_log WHERE at >= ? AND actor = 'owner' ORDER BY at DESC, id DESC LIMIT 20`, since);

  // Key numbers.
  const activeCount = await one(env.DB,
    `SELECT COUNT(*) AS n FROM subscriptions WHERE status IN (${ACTIVE.map(() => '?').join(',')})`, ...ACTIVE);
  const prod = await one(env.DB,
    `SELECT COUNT(*) AS orders, COALESCE(SUM(total_meals),0) AS meals FROM orders WHERE week_of = ? AND status = 'locked'`, week);
  const wrr = await one(env.DB,
    `SELECT COALESCE(SUM(meals_per_week * tier_price_cents),0) AS cents FROM subscriptions WHERE status IN (${BILLING.map(() => '?').join(',')})`, ...BILLING);
  const rev30 = await one(env.DB,
    `SELECT COALESCE(SUM(amount_paid_cents),0) AS cents FROM invoices WHERE status = 'paid' AND created_at >= ?`, addDaysIso(-30));
  const refunds30 = await one(env.DB,
    `SELECT COALESCE(SUM(amount_cents),0) AS cents FROM payments WHERE status = 'refunded' AND created_at >= ?`, addDaysIso(-30));

  // Health.
  const failedComms = await one(env.DB,
    `SELECT COUNT(*) AS n FROM comms_log WHERE ghl_status = 'failed' AND sent_at >= ?`, addDaysIso(-1));
  const stuckWebhooks = await one(env.DB,
    `SELECT COUNT(*) AS n FROM stripe_events WHERE processed_at IS NULL AND received_at < ?`, addDaysIso(-0.05)); // >~1h old

  const failed = failedComms?.n || 0;
  const stuck = stuckWebhooks?.n || 0;
  const healthOk = failed === 0 && stuck === 0;

  const lines = [];
  if (activity.length) activity.forEach((a) => lines.push(`${a.n}× ${a.action.replace('owner_', '').replace(/_/g, ' ')}`));
  else lines.push('No customer activity in the last 24h.');
  recent.slice(0, 8).forEach((r) => { try { const d = JSON.parse(r.detail_json || '{}'); if (d.summary) lines.push('• ' + d.summary); } catch { /* skip */ } });
  lines.push('—');
  lines.push(`Active subscriptions: ${activeCount?.n || 0}`);
  lines.push(`This week locked: ${prod?.orders || 0} orders / ${prod?.meals || 0} meals (${week})`);
  lines.push(`Weekly recurring (list): ${money(wrr?.cents || 0)}`);
  lines.push(`Net revenue 30d: ${money((rev30?.cents || 0) + (refunds30?.cents || 0))}`);
  lines.push(`Health: ${healthOk ? 'all clear ✅' : `⚠️ ${failed} failed comms, ${stuck} stuck webhooks`}`);

  const summary = `Daily digest — ${activeCount?.n || 0} active, ${prod?.meals || 0} meals this week` + (healthOk ? '' : ' · ⚠️ HEALTH');
  await ownerNotify(env, 'owner_daily_digest', summary, { entity: 'system', lines });

  // Escalate health problems as a BIG (SMS-eligible) alert so they don't sit unseen until morning.
  if (!healthOk) {
    await ownerNotify(env, 'owner_health_alert',
      `GT health: ${failed} failed comms, ${stuck} webhooks stuck >1h — check /app/ops`,
      { entity: 'system', lines: [`failed_comms_24h: ${failed}`, `stuck_webhooks: ${stuck}`] });
  }

  // Sunday morning (this digest runs 13:00 UTC ≈ 7am MT, so UTC-Sunday == Sunday morning in Denver):
  // nudge an owner to CONFIRM this week's menu live. Only fires when action is needed (menu not yet live) —
  // if it's already live, stay quiet. See the owner-confirmation gate (confirm-menu.js).
  if (new Date().getUTCDay() === 0) {
    const orderWk = orderableWeek();
    const menuRow = await one(env.DB, `SELECT status FROM weekly_menus WHERE week_of = ?`, orderWk);
    const st = menuRow ? (menuRow.status || 'live') : null;
    if (st !== 'live') {
      const staged = st === 'staged';
      await ownerNotify(env, 'owner_set_menu',
        staged
          ? `Sunday: CONFIRM this week's Gainz Train menu to go live (week of ${orderWk})`
          : `Sunday: set + confirm this week's Gainz Train menu (week of ${orderWk})`,
        {
          entity: 'system',
          lines: [
            staged
              ? 'A menu is STAGED for this week but NOT live yet. Open the prep dashboard → Menu tab, review it, then hit "Confirm & Go Live" so customers can order.'
              : "Open the prep dashboard → Menu tab, build this week's menu, hit Finalize, then \"Confirm & Go Live\" so customers can order.",
            'Dashboard: https://gainztrainprep.com/app/ops/prep/ (log in first)',
            `Nothing is visible to customers until you confirm. They can then order the week of ${orderWk} until Friday 11:00pm MT.`,
          ],
        });
    }
  }

  return ok({ summary, health: { failed_comms_24h: failed, stuck_webhooks: stuck, ok: healthOk }, activity });
}
