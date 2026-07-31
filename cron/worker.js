// gainztrain-cron — standalone scheduled Worker that drives the Gainz Train weekly cycle.
// Cloudflare Pages Functions can't self-schedule, so this separate Worker fires the admin
// endpoints on cron. All cron times are UTC.
//
// ⚠️ WHY EVERY TRIGGER IS `* * *` (daily) AND THE DAY IS CHECKED IN JS:
// Until 2026-07-17 these triggers used cron day-of-week fields (`* * 3`, `* * 5`, `* * 6`) and every
// one of them FIRED A FULL DAY EARLY in production, for weeks, silently:
//   `0 17 * * 3` (want Wed) fired Tue 2026-07-14 17:00Z   — pick reminders
//   `0 23 * * 5` (want Fri) fired Thu 2026-07-16 23:00Z   — "last call" reminder
//   `30 7 * * 6` (want Sat) fired Fri 2026-07-17 07:30Z   — LOCK: closed ordering a day early and
//                                                            emailed 6 customers "your order is locked"
// Hour and minute were always exact; only the weekday was off, consistently by one, across all three.
// Rather than depend on the cron day-of-week field at all, every trigger now runs DAILY and the
// intended weekday is enforced with JS `getUTCDay()` (0=Sun … 6=Sat), which is unambiguous and was
// already proven correct by the Monday menu-failsafe branch below. Do NOT "simplify" these back into
// cron day-of-week fields.
//
// Deploy:  wrangler deploy   (from this dir)
// Secret:  wrangler secret put ADMIN_TOKEN   (= the gainztrain-website ADMIN_TOKEN)
const BASE = 'https://gainztrainprep.com';

// JS weekday constants (Date#getUTCDay).
const WED = 3, FRI = 5, SAT = 6, MON = 1;

// Fire an admin endpoint AND check the result — a 401 (token drift) / 404 (no menu) / 500 must NOT pass
// silently or a whole week's cook/reminders is skipped with no trace. Surfaces in `wrangler tail` + the
// CF Workers logs. (A push alert / gt_health probe is the proper next step.)
async function hit(env, path) {
  try {
    const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'X-Admin-Token': env.ADMIN_TOKEN } });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error(`[gainztrain-cron] FAIL ${path} -> ${r.status} ${body.slice(0, 300)}`);
    } else {
      console.log(`[gainztrain-cron] OK ${path} -> ${r.status}`);
    }
    return r;
  } catch (e) {
    console.error(`[gainztrain-cron] THREW ${path}: ${String(e).slice(0, 200)}`);
  }
}

export default {
  async scheduled(event, env, ctx) {
    const day = new Date(event.scheduledTime).getUTCDay();

    if (event.cron === '0 17 * * *') {
      // Wednesday 17:00 UTC (~10–11am Mountain) — remind subscribers who haven't picked.
      if (day === WED) ctx.waitUntil(hit(env, '/api/admin/send-reminders'));
      // Saturday 17:00 UTC (11am MDT) — POST-BILLING reconciliation. Billing anchors fire at 15:00 UTC,
      // so this is the run that catches a charge that FAILED this morning, while there's still a day
      // before Sunday delivery to fix the card or pull them from the run.
      if (day === SAT) ctx.waitUntil(hit(env, '/api/admin/payment-order-audit'));
    } else if (event.cron === '0 23 * * *') {
      // Friday 23:00 UTC (5pm MDT / 4pm MST) — LAST CALL, hours before tonight's MIDNIGHT MT cutoff.
      if (day === FRI) ctx.waitUntil(hit(env, '/api/admin/send-reminders?final=1'));
    } else if (event.cron === '30 7 * * *') {
      // Saturday 07:30 UTC — safely AFTER the Friday-midnight MT cutoff (Sat 06:00Z MDT / 07:00Z MST):
      // lock complete orders + auto-fill anyone who didn't pick, so the kitchen has the final list to
      // shop Saturday morning. Margin is 1.5h in summer / 0.5h in winter — do not move this earlier.
      if (day === SAT) ctx.waitUntil(hit(env, '/api/admin/lock-week'));
    } else if (event.cron === '0 13 * * *') {
      // Daily 13:00 UTC (~7am MDT / 6am MST) — owner morning digest + health probe. Emails the owners
      // only if OWNER_NOTIFY_ENABLED=true; escalates an SMS if a health signal trips.
      ctx.waitUntil(hit(env, '/api/admin/daily-digest'));
      // Saturday-only: PRE-SHOP reconciliation, ~2h after the lock and ~2h before billing. This is the
      // one that catches a paying customer the kitchen has no order for (Jameson) or an order stuck in
      // 'pending' instead of 'locked' (Jeferson) — i.e. money in, no food out — while Jayson can still
      // act on it. The post-billing pass at 17:00 UTC catches the money-out-no-money direction.
      if (day === SAT) ctx.waitUntil(hit(env, '/api/admin/payment-order-audit'));
      // Monday-only:
      //   - prune the in-app feed (>120d)
      //   - MENU FAILSAFE: if no owner confirmed this week's menu, auto-publish it (a staged menu is
      //     confirmed; otherwise last week's menu is rolled forward) so customers aren't stuck. Runs
      //     ~6–7am MT Monday, before the day's ordering. No-ops if the menu is already live.
      if (day === MON) {
        ctx.waitUntil(hit(env, '/api/admin/prune-notifications'));
        ctx.waitUntil(hit(env, '/api/admin/menu-failsafe'));
      }
    }
  },
};
