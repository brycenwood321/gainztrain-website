// POST /api/admin/menu-failsafe — Monday safety net for the owner-confirmation gate. Run by the cron
// worker on Monday morning. If the orderable week's menu is NOT live yet (owners never confirmed it),
// auto-publish so customers aren't stuck with a dead week:
//   - a STAGED menu (built but not confirmed) is confirmed (staged -> live), OR
//   - if nothing usable is staged, LAST WEEK'S live menu is ROLLED FORWARD (copied) and published.
// Always alerts the owners that the failsafe fired (and what it did). Admin-token only (cron). Fires the
// still-gated customer "new menu" blast on go-live, same as a normal confirm.
import { ok } from '../../_lib/respond.js';
import { requireAdmin } from '../../_lib/admin.js';
import { one, all, run, nowIso } from '../../_lib/db.js';
import { orderableWeek } from '../../_lib/menu.js';
import { ownerNotify } from '../../_lib/owner_notify.js';
import { notify } from '../../_lib/notify.js';

const ANNOUNCE_STATUSES = ['active', 'trialing', 'past_due'];

function mealCountOf(json) { try { return JSON.parse(json || '[]').length; } catch { return 0; } }

// Customer "new menu dropped" blast — GATED off until env.MENU_BLAST_ENABLED==='true'. Deduped per week.
// Returns { gated, targets, sent }: gated = the production flag is off (nothing was even attempted),
// targets = announce-eligible customers, sent = sends that were not deduped. The three are distinct on
// purpose: a Monday response that only said "0 sent" could not tell "flag off" from "everyone already
// had it", and a check that cannot see its input must not judge.
async function blast(env, week) {
  if (String(env.MENU_BLAST_ENABLED) !== 'true') return { gated: true, targets: 0, sent: 0 };
  const subs = await all(env.DB,
    `SELECT c.id AS customer_id, c.email, c.first_name, c.ghl_contact_id
     FROM subscriptions s JOIN customers c ON c.id = s.customer_id
     WHERE s.status IN (${ANNOUNCE_STATUSES.map(() => '?').join(',')}) AND s.meals_per_week > 0 AND s.origin = 'app'`,
    ...ANNOUNCE_STATUSES);
  let n = 0;
  for (const sub of subs) {
    const cust = { id: sub.customer_id, email: sub.email, first_name: sub.first_name, ghl_contact_id: sub.ghl_contact_id };
    const r = await notify(env, cust, 'menu_posted', { weekOf: week }, { dedupKey: `menu_posted:${week}:${cust.id}` });
    if (r.ok && !r.deduped) n++;
  }
  return { gated: false, targets: subs.length, sent: n };
}

export async function onRequestPost(context) {
  const { env } = context;
  const denied = await requireAdmin(context);
  if (denied) return denied;

  const week = orderableWeek();
  const now = nowIso();
  const row = await one(env.DB, `SELECT status, meals_json FROM weekly_menus WHERE week_of = ?`, week);
  const count = row ? mealCountOf(row.meals_json) : 0;

  // Already live with meals (an owner confirmed in time). This is the normal path, and it is ALSO the
  // Monday sweep for the customer "new menu" email: menus get confirmed early (good), and the
  // confirm-time blast only fires when the confirmed week is the orderable one, so an early confirm
  // silenced the email forever (found 2026-09-02, it had never sent). blast() dedups per week+customer,
  // so a menu that was announced at confirm time sends nothing twice.
  if (row && row.status === 'live' && count > 0) {
    const b = await blast(env, week);
    return ok(b.gated
      ? { week_of: week, action: 'none', reason: 'menu already live', blast_gated: true }
      : { week_of: week, action: 'none', reason: 'menu already live', blast: b.sent, blast_targets: b.targets });
  }

  // Case 1: a staged menu exists — confirm it (publish the work that was already prepared).
  if (row && row.status === 'staged' && count > 0) {
    await run(env.DB, `UPDATE weekly_menus SET status='live', published_at=?, updated_at=? WHERE week_of = ?`, now, now, week);
    const announced = (await blast(env, week)).sent;
    await ownerNotify(env, 'owner_menu_failsafe',
      `Failsafe published your STAGED menu for week of ${week} (no one confirmed by Monday).`,
      { entity: 'system', lines: [
        'A menu was staged but never confirmed, so the Monday failsafe published it — customers can order now.',
        `Week of ${week}, ${count} meals.`,
        'If that is not what you wanted, edit + re-finalize in the prep dashboard now.',
      ] });
    return ok({ week_of: week, action: 'published_staged', meals: count, blast: announced });
  }

  // Case 2: nothing usable is staged — roll last week's live menu forward so customers still have a menu.
  const prev = await one(env.DB,
    `SELECT week_of, meals_json FROM weekly_menus WHERE week_of < ? AND status = 'live' AND meals_json IS NOT NULL
     ORDER BY week_of DESC LIMIT 1`, week);
  if (!prev || mealCountOf(prev.meals_json) === 0) {
    await ownerNotify(env, 'owner_menu_failsafe',
      `⚠️ Failsafe could NOT set a menu for week of ${week} — nothing staged and no previous menu to copy. Ordering is CLOSED. Fix it in the prep dashboard ASAP.`,
      { entity: 'system', lines: [`Week of ${week} has no menu and there is nothing to roll forward. Build one now.`] });
    return ok({ week_of: week, action: 'failed', reason: 'no previous menu to roll forward' });
  }

  const copied = mealCountOf(prev.meals_json);
  await run(env.DB,
    `INSERT INTO weekly_menus (week_of, label, meals_json, published_at, created_at, updated_at, source, status)
     VALUES (?, 'This Week', ?, ?, ?, ?, 'failsafe', 'live')
     ON CONFLICT(week_of) DO UPDATE SET meals_json=excluded.meals_json, label=excluded.label,
       published_at=excluded.published_at, updated_at=excluded.updated_at, source='failsafe', status='live'`,
    week, prev.meals_json, now, now, now);
  const announced = (await blast(env, week)).sent;
  await ownerNotify(env, 'owner_menu_failsafe',
    `Failsafe rolled last week's menu forward for week of ${week} (no one confirmed by Monday).`,
    { entity: 'system', lines: [
      `No menu was staged, so last week's menu (from ${prev.week_of}, ${copied} meals) was copied + published so customers can order.`,
      'Swap it for this week\'s real menu in the prep dashboard when you can.',
    ] });
  return ok({ week_of: week, action: 'rolled_forward', copied_from: prev.week_of, meals: copied, blast: announced });
}
