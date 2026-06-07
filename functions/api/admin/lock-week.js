// POST /api/admin/lock-week — run at the Friday cutoff for a week (default: the upcoming Sunday).
// For every active subscription: if they picked a complete order, lock it; if they didn't pick (or
// picked an incomplete set), AUTO-FILL by repeating last week's meals (closest substitution for any
// meal not on the new menu; even-spread if they have no history), then lock. Admin-gated.
//
//   curl -X POST https://host/api/admin/lock-week -H "X-Admin-Token: $ADMIN_TOKEN"   # locks upcoming Sunday
//   add ?week_of=YYYY-MM-DD to lock a specific week.
import { ok, fail } from '../../_lib/respond.js';
import { one, all, run, nowIso } from '../../_lib/db.js';
import { upcomingSunday } from '../../_lib/menu.js';
import { repeatLastWeek, evenSpread } from '../../_lib/substitute.js';
import { MIN_MEALS } from '../../_lib/plans.js';

// Only these get meals cooked. 'paused' is deliberately EXCLUDED — a paused customer isn't billed
// and gets no meals. Legacy subs with meals_per_week < MIN_MEALS are skipped + surfaced, not locked.
const COOKABLE = ['active', 'trialing', 'past_due'];

async function writeSelectionsAndOrder(env, sub, weekOf, menu, qtyByPos, now) {
  let total = 0, upchargeTotal = 0;
  for (const m of menu) {
    const qty = qtyByPos.get(m.position) || 0;
    total += qty;
    const upMealCents = Math.round((m.upcharge_per_meal || 0) * 100);
    upchargeTotal += qty * upMealCents;
    await run(env.DB,
      `INSERT INTO meal_selections (id, subscription_id, week_of, meal_position, meal_name, qty, upcharge_per_meal_cents, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(subscription_id, week_of, meal_position) DO UPDATE SET
         meal_name=excluded.meal_name, qty=excluded.qty, upcharge_per_meal_cents=excluded.upcharge_per_meal_cents, updated_at=excluded.updated_at`,
      `${sub.id}:${weekOf}:${m.position}`, sub.id, weekOf, m.position, m.name, qty, upMealCents, now, now);
  }
  await run(env.DB,
    `INSERT INTO orders (id, subscription_id, customer_id, week_of, status, total_meals, upcharge_total_cents, locked_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'locked', ?, ?, ?, ?, ?)
     ON CONFLICT(subscription_id, week_of) DO UPDATE SET
       status='locked', total_meals=excluded.total_meals, upcharge_total_cents=excluded.upcharge_total_cents,
       locked_at=excluded.locked_at, updated_at=excluded.updated_at`,
    `${sub.id}:${weekOf}`, sub.id, sub.customer_id, weekOf, total, upchargeTotal, now, now, now);
  return total;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const token = request.headers.get('x-admin-token') || '';
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return fail(401, 'unauthorized', 'Bad admin token.');

  const weekOf = new URL(request.url).searchParams.get('week_of') || upcomingSunday();
  const menuRow = await one(env.DB, `SELECT meals_json FROM weekly_menus WHERE week_of = ?`, weekOf);
  if (!menuRow) return fail(404, 'no_menu', `No menu published for ${weekOf}.`);
  const menu = JSON.parse(menuRow.meals_json);
  if (!Array.isArray(menu) || menu.length === 0) return fail(422, 'empty_menu', `Menu for ${weekOf} has no meals — fix the menu before locking.`);

  const subs = await all(env.DB,
    `SELECT id, customer_id, meals_per_week FROM subscriptions WHERE status IN (${COOKABLE.map(() => '?').join(',')})`,
    ...COOKABLE);

  const now = nowIso();
  const summary = { week_of: weekOf, total_subs: subs.length, locked_as_picked: 0, autofilled: 0, skipped: 0, errors: [] };

  for (const sub of subs) {
    try {
      // Skip legacy / misconfigured subs (no real tier yet) — surface them instead of locking an
      // empty order. These need enrich-ghl to set meals_per_week first.
      if (!(sub.meals_per_week >= MIN_MEALS)) {
        summary.skipped++;
        summary.errors.push(`sub ${sub.id}: meals_per_week=${sub.meals_per_week} (< ${MIN_MEALS}) — needs enrichment, not locked`);
        continue;
      }
      const picked = await all(env.DB,
        `SELECT meal_position, qty FROM meal_selections WHERE subscription_id = ? AND week_of = ? AND qty > 0`,
        sub.id, weekOf);
      const pickedTotal = picked.reduce((s, r) => s + r.qty, 0);

      if (pickedTotal === sub.meals_per_week) {
        // Lock their order, recomputing total + upcharge from the actual picks (don't trust a
        // possibly-stale order row, and write one if it's somehow missing).
        const upRow = await one(env.DB,
          `SELECT COALESCE(SUM(qty * upcharge_per_meal_cents), 0) AS up FROM meal_selections WHERE subscription_id = ? AND week_of = ?`,
          sub.id, weekOf);
        await run(env.DB,
          `INSERT INTO orders (id, subscription_id, customer_id, week_of, status, total_meals, upcharge_total_cents, locked_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'locked', ?, ?, ?, ?, ?)
           ON CONFLICT(subscription_id, week_of) DO UPDATE SET status='locked', total_meals=excluded.total_meals,
             upcharge_total_cents=excluded.upcharge_total_cents, locked_at=excluded.locked_at, updated_at=excluded.updated_at`,
          `${sub.id}:${weekOf}`, sub.id, sub.customer_id, weekOf, pickedTotal, upRow?.up || 0, now, now, now);
        summary.locked_as_picked++;
        continue;
      }

      // Auto-fill from last week.
      const prevWeekRow = await one(env.DB,
        `SELECT week_of FROM meal_selections WHERE subscription_id = ? AND qty > 0 AND week_of < ? ORDER BY week_of DESC LIMIT 1`,
        sub.id, weekOf);
      let qtyByPos;
      if (prevWeekRow) {
        const prevSel = await all(env.DB,
          `SELECT meal_position, qty FROM meal_selections WHERE subscription_id = ? AND week_of = ? AND qty > 0`,
          sub.id, prevWeekRow.week_of);
        const prevMenuRow = await one(env.DB, `SELECT meals_json FROM weekly_menus WHERE week_of = ?`, prevWeekRow.week_of);
        const prevMenu = prevMenuRow ? JSON.parse(prevMenuRow.meals_json) : [];
        const prevQty = new Map(prevSel.map((r) => [r.meal_position, r.qty]));
        qtyByPos = repeatLastWeek(prevMenu, prevQty, menu);
        const t = [...qtyByPos.values()].reduce((a, b) => a + b, 0);
        if (t !== sub.meals_per_week) qtyByPos = evenSpread(menu, sub.meals_per_week); // tier changed / mismatch
      } else {
        qtyByPos = evenSpread(menu, sub.meals_per_week);
      }
      await writeSelectionsAndOrder(env, sub, weekOf, menu, qtyByPos, now);
      await run(env.DB,
        `INSERT INTO audit_log (at, actor, entity, action, detail_json) VALUES (?, 'cron:lock-week', ?, 'autofilled', ?)`,
        now, `subscription:${sub.id}`, JSON.stringify({ week_of: weekOf, source: prevWeekRow ? 'repeat_last_week' : 'even_spread' }));
      summary.autofilled++;
    } catch (e) {
      summary.errors.push(`${sub.id}: ${String(e).slice(0, 100)}`);
    }
  }
  return ok({ summary });
}
