// POST /api/admin/lifecycle-comms — the daily pass over three moments the system used to stay silent
// through. Admin-gated, idempotent, and safe to run more than once a day.
//
// Every send goes through notify() with a dedupKey, so the unique index on comms_log.dedup_key is what
// guarantees at-most-once — not the date arithmetic below. That matters: the windows are deliberately
// RANGES rather than exact days so a missed cron run still catches people the next morning instead of
// skipping them forever.
//
//   ?dry=1  → report who WOULD be messaged, send nothing. Use this first.
import { ok, fail } from '../../_lib/respond.js';
import { requireAdmin } from '../../_lib/admin.js';
import { all } from '../../_lib/db.js';
import { notify } from '../../_lib/notify.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const denied = await requireAdmin(context);
  if (denied) return denied;

  const dry = new URL(request.url).searchParams.get('dry') === '1';
  const summary = { dry, first_week_checkin: 0, checkout_abandoned: 0, winback: 0, skipped_deduped: 0, targets: [] };

  const send = async (cust, eventKey, data, dedupKey) => {
    summary.targets.push({ event: eventKey, email: cust.email });
    if (dry) return;
    const r = await notify(env, cust, eventKey, data, { dedupKey });
    if (r.deduped) summary.skipped_deduped++;
    else if (r.ok) summary[eventKey]++;
  };

  try {
    // ── 1. FIRST-WEEK CHECK-IN ──
    // 3–6 days after their first delivery, i.e. inside the 7-day Full Week Guarantee window while they
    // can still act on it. Keyed on customer id alone: this is a once-per-lifetime message.
    const firstWeek = await all(env.DB,
      `SELECT c.id, c.email, c.first_name, c.ghl_contact_id, MIN(o.week_of) AS first_week
         FROM customers c
         JOIN orders o ON o.customer_id = c.id AND o.status = 'locked'
        GROUP BY c.id
       HAVING julianday('now') - julianday(MIN(o.week_of)) BETWEEN 3 AND 6`);
    for (const c of firstWeek) {
      await send(c, 'first_week_checkin', { firstName: c.first_name }, `checkin:${c.id}`);
    }

    // ── 2. ABANDONED CHECKOUT ──
    // An account with no subscription row at all, 2–14 days old. The floor of 2 days avoids nudging
    // someone who is mid-signup in another tab; the ceiling stops us waking up months-dead accounts
    // the first time this ever runs.
    const abandoned = await all(env.DB,
      `SELECT c.id, c.email, c.first_name, c.ghl_contact_id
         FROM customers c
        WHERE c.role = 'customer'
          AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.customer_id = c.id)
          AND julianday('now') - julianday(c.created_at) BETWEEN 2 AND 14`);
    for (const c of abandoned) {
      await send(c, 'checkout_abandoned', {}, `abandoned:${c.id}`);
    }

    // ── 3. WIN-BACK ──
    // 14–21 days after a subscription actually ended. Keyed on the SUBSCRIPTION, not the customer, so
    // somebody who leaves twice over a year gets asked twice — which is the point, since the question
    // is why they left THIS time. Excludes anyone who has since resubscribed.
    const gone = await all(env.DB,
      `SELECT c.id, c.email, c.first_name, c.ghl_contact_id, s.id AS sub_id
         FROM subscriptions s
         JOIN customers c ON c.id = s.customer_id
        WHERE s.status = 'canceled'
          AND julianday('now') - julianday(s.updated_at) BETWEEN 14 AND 21
          AND NOT EXISTS (
            SELECT 1 FROM subscriptions s2
             WHERE s2.customer_id = c.id AND s2.status IN ('active','trialing','past_due','paused'))`);
    for (const c of gone) {
      await send(c, 'winback', { firstName: c.first_name }, `winback:${c.sub_id}`);
    }
  } catch (e) {
    return fail(500, 'lifecycle_failed', String(e?.message || e).slice(0, 200));
  }

  return ok({ summary });
}
