// gainztrain-cron — standalone scheduled Worker that drives the Gainz Train weekly cycle.
// Cloudflare Pages Functions can't self-schedule, so this separate Worker fires the admin
// endpoints on cron. All cron times are UTC.
//
// Deploy:  wrangler deploy   (from this dir)
// Secret:  wrangler secret put ADMIN_TOKEN   (= the gainztrain-website ADMIN_TOKEN)
const BASE = 'https://gainztrainprep.com';

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
    // (Wed 16:00 menus.json auto-publish RETIRED 2026-07-11 — the prep dashboard Finalize→Confirm
    // flow owns menus; the Monday menu-failsafe covers a week with no live menu. Freed cron slot is
    // reserved for the ad-spend kill-switch.)
    if (event.cron === '0 17 * * 3') {
      // Wednesday 17:00 UTC (~10–11am Mountain) — remind subscribers who haven't picked.
      ctx.waitUntil(hit(env, '/api/admin/send-reminders'));
    } else if (event.cron === '0 23 * * 5') {
      // Friday 23:00 UTC (5pm MDT / 4pm MST) — LAST CALL, hours before tonight's 11:59pm MT cutoff.
      // (Was Fri 15:00Z when the cutoff was Friday morning.)
      ctx.waitUntil(hit(env, '/api/admin/send-reminders?final=1'));
    } else if (event.cron === '30 7 * * 6') {
      // Saturday 07:30 UTC (1:30am MDT / 12:30am MST) — just after the Friday 11:59pm MT cutoff
      // (Sat 05:59Z MDT / 06:59Z MST) — lock complete orders + auto-fill anyone who didn't pick, so
      // the kitchen has the final list to shop Saturday morning. (Moved from Fri 19:00Z 2026-07-11
      // when the cutoff moved from 11:59am to 11:59pm MT.)
      ctx.waitUntil(hit(env, '/api/admin/lock-week'));
    } else if (event.cron === '0 13 * * *') {
      // Daily 13:00 UTC (~7am MDT / 6am MST) — owner morning digest + health probe. Emails the owners
      // only if OWNER_NOTIFY_ENABLED=true; escalates an SMS if a health signal trips.
      ctx.waitUntil(hit(env, '/api/admin/daily-digest'));
      // Monday-only (folded into this daily trigger to stay within the 5-cron-trigger limit):
      //   - prune the in-app feed (>120d)
      //   - MENU FAILSAFE: if no owner confirmed this week's menu, auto-publish it (a staged menu is
      //     confirmed; otherwise last week's menu is rolled forward) so customers aren't stuck. Runs
      //     ~6–7am MT Monday, before the day's ordering. No-ops if the menu is already live.
      if (new Date(event.scheduledTime).getUTCDay() === 1) {
        ctx.waitUntil(hit(env, '/api/admin/prune-notifications'));
        ctx.waitUntil(hit(env, '/api/admin/menu-failsafe'));
      }
    }
  },
};
