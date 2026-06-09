// gainztrain-cron — standalone scheduled Worker that drives the Gainz Train weekly cycle.
// Cloudflare Pages Functions can't self-schedule, so this separate Worker fires the admin
// endpoints on cron. All cron times are UTC.
//
// Deploy:  wrangler deploy   (from this dir)
// Secret:  wrangler secret put ADMIN_TOKEN   (= the gainztrain-website ADMIN_TOKEN)
const BASE = 'https://gainztrainprep.com';

async function hit(env, path) {
  return fetch(`${BASE}${path}`, { method: 'POST', headers: { 'X-Admin-Token': env.ADMIN_TOKEN } });
}

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === '0 17 * * 3') {
      // Wednesday 17:00 UTC (~10–11am Mountain) — remind subscribers who haven't picked.
      ctx.waitUntil(hit(env, '/api/admin/send-reminders'));
    } else if (event.cron === '0 22 * * 5') {
      // Friday 22:00 UTC (~3–4pm Mountain) — LAST CALL before the 11pm Mountain cutoff.
      ctx.waitUntil(hit(env, '/api/admin/send-reminders?final=1'));
    } else if (event.cron === '30 6 * * 6') {
      // Saturday 06:30 UTC — after the Friday 11pm Mountain cutoff (Sat 05:00Z MDT / 06:00Z MST) —
      // lock complete orders + auto-fill anyone who didn't pick.
      ctx.waitUntil(hit(env, '/api/admin/lock-week'));
    } else if (event.cron === '0 8 * * 0') {
      // Sunday 08:00 UTC — prune in-app feed rows older than 120 days (storage hygiene).
      ctx.waitUntil(hit(env, '/api/admin/prune-notifications'));
    }
  },
};
