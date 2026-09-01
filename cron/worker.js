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
const WED = 3, FRI = 5, SAT = 6, MON = 1, SUN = 0;

// YYYY-MM-DD for a Date, in UTC. Used to hand the pickup reminder an EXPLICIT week rather than
// letting the endpoint fall back to upcomingSunday(). That default is correct at 13:00 UTC on a
// Sunday (getUTCDay() is 0, so it returns today), but "correct because of the hour we happen to
// fire at" is exactly the kind of thing that breaks when someone moves a trigger. Send the date.
const isoDate = (d) => d.toISOString().slice(0, 10);

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

// JSON variants for the verify flow below. Failures return null rather than throwing: a broken
// verify must never take down the send it was checking.
async function callJson(env, method, path, body) {
  try {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'X-Admin-Token': env.ADMIN_TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!r.ok) { console.error(`[gainztrain-cron] FAIL ${method} ${path} -> ${r.status}`); return null; }
    return await r.json();
  } catch (e) {
    console.error(`[gainztrain-cron] THREW ${method} ${path}: ${String(e).slice(0, 200)}`);
    return null;
  }
}

// Sunday pickup reminder, SEND then VERIFY. The launchd one-shot this cron replaced had one piece
// of real value: it read comms-audit afterwards as GROUND TRUTH and went loud when the send's own
// summary and the log disagreed (memory: a-send-is-not-done-until-the-log-says-so). This restores
// that. The sender's summary is never trusted; the per-channel comms_log rows decide, and any
// orphan/failure pages the owners through /api/admin/alert.
async function pickupReminderWithVerify(env, week) {
  // 1. Drive the send until it reports nothing left to attempt (the endpoint batches under the
  // subrequest cap; dedup makes extra passes free).
  let summary = null;
  for (let pass = 1; pass <= 6; pass++) {
    const d = await callJson(env, 'POST', `/api/admin/pickup-notice?event=reminder&week=${week}`);
    summary = d && d.summary;
    if (!summary || !summary.remaining) break;
  }

  // 2. Ground truth from the log, bounded to today. since=0.5 (12h) covers clock skew without
  // reaching into last week's rows.
  const audit = await callJson(env, 'GET', `/api/admin/comms-audit?template=pickup_reminder&since=0.5`);
  if (!audit) {
    // Cannot see the log means cannot verify. Report "did not look", never "looks fine"
    // (memory: a-check-that-cannot-see-its-input-must-not-judge).
    await callJson(env, 'POST', '/api/admin/alert', {
      summary: `Pickup reminder UNVERIFIED for ${week}: comms-audit unreachable after the send`,
      lines: ['The send may be fine. Nothing confirmed it. Check /api/admin/comms-audit?template=pickup_reminder&since=1 by hand.'],
    });
    return;
  }

  const orphans = (audit.counts && audit.counts.orphans) || 0;
  const failed = (audit.counts && audit.counts.failed) || 0;
  if (orphans > 0 || failed > 0) {
    const names = [...(audit.orphans || []), ...(audit.failed || [])].map((p) => p.name || p.email).slice(0, 12);
    await callJson(env, 'POST', '/api/admin/alert', {
      summary: `Pickup reminder INCOMPLETE for ${week}: ${orphans} claimed-not-sent, ${failed} failed`,
      lines: [
        `Missing: ${names.join(', ')}`,
        'Release stuck claims: POST /api/admin/comms-audit?template=pickup_reminder&release_orphans=1',
        'Then re-run: POST /api/admin/pickup-notice?event=reminder',
      ],
    });
    console.error(`[gainztrain-cron] pickup reminder verify FAILED: ${orphans} orphans, ${failed} failed`);
  } else {
    console.log(`[gainztrain-cron] pickup reminder verified: ${(audit.counts && audit.counts.delivered) || 0} delivered, 0 orphans, 0 failed`);
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
      // Daily — pull yesterday's per-ad spend from Meta into marketing_spend and audit the variant
      // registry for drift. Runs BEFORE anyone reads /app/ops/marketing/ in the morning, so the cost
      // half of the funnel is as current as the signup half. Was a laptop-only Python script, which
      // meant CAC went stale the moment nobody remembered to run it. Re-pulls a 30-day window because
      // Meta revises spend retroactively; the upsert on (day, ad_id) makes that idempotent.
      // No-ops with skipped:true until META_ADS_TOKEN + META_AD_ACCOUNT are set on the Pages project.
      ctx.waitUntil(hit(env, '/api/admin/meta-spend-sync'));
      // Daily — the three lifecycle moments the system used to stay silent through: a check-in a few
      // days into someone's FIRST week (while the Full Week Guarantee is still claimable), a nudge to
      // an account that never finished checkout, and a win-back two weeks after a subscription ended.
      // Idempotent by dedupKey, not by the date maths, so a missed run catches people the next morning
      // rather than skipping them permanently. Add ?dry=1 by hand to see who would be messaged.
      ctx.waitUntil(hit(env, '/api/admin/lifecycle-comms'));
      // Saturday-only: PRE-SHOP reconciliation, ~2h after the lock and ~2h before billing. This is the
      // one that catches a paying customer the kitchen has no order for (Jameson) or an order stuck in
      // 'pending' instead of 'locked' (Jeferson) — i.e. money in, no food out — while Jayson can still
      // act on it. The post-billing pass at 17:00 UTC catches the money-out-no-money direction.
      if (day === SAT) ctx.waitUntil(hit(env, '/api/admin/payment-order-audit'));
      // Sunday-only: PICKUP REMINDER, ~7am MDT / 6am MST, three hours before the 10:00-10:45 window.
      // This replaces ~/Library/Scripts/BrycenHQ/gt_pickup_reminder.py, which was deliberately
      // one-shot for 2026-08-23 and therefore sent NOTHING on 08-30 or any Sunday after. Brycen
      // asked for a standing weekly job on 2026-08-31, which overrides that script's stated reason
      // for being one-shot ("customer messages going out with no human in the loop").
      //
      // The endpoint is idempotent per customer per week per event via its dedupKey, so a retry or a
      // double fire cannot re-blast anyone. Since 2026-08-31 the send is also VERIFIED: see
      // pickupReminderWithVerify above, which reads comms-audit afterwards and pages the owners
      // when the log disagrees with the sender.
      if (day === SUN) {
        ctx.waitUntil(pickupReminderWithVerify(env, isoDate(new Date(event.scheduledTime))));
      }
      // Saturday-only: sync phones D1 -> GHL BEFORE Sunday's texts. 4 of 20 customers were silently
      // unreachable on 08-30 because their GHL contact predated their phone number; this closes the
      // gap the day before it matters instead of discovering it in the failure column afterwards.
      if (day === SAT) ctx.waitUntil(hit(env, '/api/admin/phone-sync'));
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
