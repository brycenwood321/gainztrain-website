// POST /api/admin/marketing-weekly — the Monday "marketing week" owner email. Cron hits it in the Monday
// block of cron/worker.js. Email-only (not in owner_notify BIG): it is a report, not a page. When spend
// was zero it says so in words; a null CAC is not a number anyone should read on a phone.
import { ok } from '../../_lib/respond.js';
import { requireAdmin } from '../../_lib/admin.js';
import { ownerNotify } from '../../_lib/owner_notify.js';
import { buildChannelReport } from './channel-report.js';
import { all, one } from '../../_lib/db.js';
import { reasonLabel } from '../../_lib/reasons.js';
import { minutesByPerson } from './marketing-time.js';
import { STOP_TRIGGER } from './daily-digest.js';
import { referralStats } from './referrals.js';

const money = (c) => `$${((c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

export async function onRequestPost(context) {
  const { env } = context;
  const denied = await requireAdmin(context);
  if (denied) return denied;

  const r = await buildChannelReport(env.DB, { days: 7 });
  const t = r.totals.first_touch;
  const spentRows = r.by_first_touch.filter((x) => x.spend_cents > 0);
  const spendPhrase = spentRows.length
    ? spentRows.map((x) => `${x.channel} ${money(x.spend_cents)}${x.cac_cents ? ` (CAC ${money(x.cac_cents)})` : ' (no new paying yet)'}`).join(', ')
    : 'no ad spend this week';
  const summary = `Marketing week ${r.window.start} to ${r.window.end}: ${t.new_paying} new paying, ${t.signups} signups, ${t.sessions} real sessions, ${spendPhrase}`;

  const lines = [];
  lines.push('— by first touch (what the browser said; bots excluded) —');
  for (const x of r.by_first_touch) {
    if (!x.sessions && !x.signups && !x.new_paying && !x.spend_cents) continue;
    lines.push(`• ${x.channel}: ${x.sessions} sessions, ${x.signups} signups, ${x.new_paying} new paying, ${money(x.revenue_cents)} revenue` +
      (x.spend_cents ? `, ${money(x.spend_cents)} spent, CAC ${x.cac_cents ? money(x.cac_cents) : 'n/a'}` : ''));
  }
  lines.push('— by what people said at signup —');
  for (const x of r.by_self_reported) {
    if (!x.signups && !x.new_paying) continue;
    lines.push(`• ${x.channel}: ${x.signups} signups, ${x.new_paying} new paying, ${money(x.revenue_cents)} revenue`);
  }
  // ── Plan rev 4 additions (09-28 build): the week in the owners' own terms ─────────────────────────
  const startIso = `${r.window.start}T00:00:00.000Z`;
  const endIso = `${r.window.end}T00:00:00.000Z`;

  // Why people paused or cancelled this week (subscriptions.reason_*, migration 0029). Names on purpose:
  // a count of "pickup time: 3" is useless when the Sunday meeting needs to know who to text back.
  const reasons = await all(env.DB,
    `SELECT s.reason_kind, s.reason_code, s.reason_text, c.first_name, c.email
       FROM subscriptions s JOIN customers c ON c.id = s.customer_id
      WHERE s.reason_at >= ? AND s.reason_at < ? ORDER BY s.reason_at DESC`, startIso, endIso);
  lines.push(`— paused / cancelled this week, and why (${reasons.length}) —`);
  if (!reasons.length) lines.push('• none');
  const byCode = {};
  for (const x of reasons) (byCode[x.reason_code || 'declined'] ||= []).push(x);
  for (const [code, xs] of Object.entries(byCode).sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`• ${reasonLabel(code)}: ${xs.length} — ` + xs.map((x) => `${x.first_name || x.email} (${x.reason_kind}${x.reason_text ? `, "${x.reason_text.slice(0, 80)}"` : ''})`).join('; '));
  }
  const pickupReasons = (byCode.pickup_time || []).length;
  if (reasons.length) lines.push(`Pickup time was the reason for ${pickupReasons} of ${reasons.length}. The plan's rule: if the window is the top reason, D1 stays.`);

  // What customers SAID to us this week (customers.last_inbound_*, cached from GHL by inbound-sync).
  const replies = await all(env.DB,
    `SELECT first_name, email, last_inbound_at, last_inbound_channel, last_inbound_text FROM customers
      WHERE last_inbound_at >= ? AND last_inbound_at < ? ORDER BY last_inbound_at DESC LIMIT 25`, startIso, endIso);
  const neverChecked = await one(env.DB,
    `SELECT COUNT(*) AS n FROM customers c WHERE c.ghl_contact_id IS NOT NULL AND c.inbound_synced_at IS NULL
        AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.customer_id = c.id AND (s.status IN ('active','trialing','past_due','paused') OR s.cancel_at_period_end = 1))`);
  lines.push(`— replies from customers this week (${replies.length}${neverChecked?.n ? `; ${neverChecked.n} never checked, inbound-sync has not reached them` : ''}) —`);
  if (!replies.length) lines.push('• none on record');
  for (const x of replies) lines.push(`• ${x.first_name || x.email} (${x.last_inbound_channel}, ${String(x.last_inbound_at).slice(0, 10)}): "${(x.last_inbound_text || '').slice(0, 120)}"`);

  // Minutes the owners put in (marketing_time, migration 0031). Zero rows is said as zero rows, not hidden.
  const mins = await minutesByPerson(env.DB, r.window.start, r.window.end);
  lines.push('— marketing time logged —');
  if (!mins.length) lines.push('• nothing logged. The plan asks for about two hours a week from each of you; log it in ops → Marketing.');
  for (const m of mins) lines.push(`• ${m.who}: ${m.minutes} min over ${m.sittings} sitting${m.sittings === 1 ? '' : 's'}`);

  // Delivery stops on the Sunday just delivered (the week the ops week label calls the prior Monday).
  const lastSunday = await one(env.DB,
    `SELECT o.week_of, COUNT(*) AS orders, COALESCE(SUM(o.total_meals),0) AS meals,
            COUNT(DISTINCT CASE WHEN COALESCE(o.delivery_method, c.delivery_method) = 'delivery'
                 THEN LOWER(TRIM(COALESCE(c.address,''))) || '|' || LOWER(TRIM(COALESCE(c.city,''))) || '|' || COALESCE(c.zip,'') END) AS stops
       FROM orders o JOIN customers c ON c.id = o.customer_id
      WHERE o.status IN ('locked','prepped') AND o.week_of < ? AND o.week_of >= ?
      GROUP BY o.week_of ORDER BY o.week_of DESC LIMIT 1`, endIso.slice(0, 10), startIso.slice(0, 10));
  if (lastSunday) {
    lines.push(`— kitchen, Sunday ${lastSunday.week_of} —`);
    lines.push(`• ${lastSunday.orders} orders, ${lastSunday.meals} meals, ${lastSunday.stops} delivery stops (distinct addresses)` +
      (lastSunday.stops >= STOP_TRIGGER ? ` ⚠️ at or over Jayson's ${STOP_TRIGGER}-stop line` : ''));
  }

  // Paid-cohort checkout metric, the plan's day-14 ad rule, read every Monday so the number is familiar
  // before it has to decide anything: share of PAID Utah sessions (fbclid, or a facebook/instagram utm)
  // that clicked "Continue to payment" (or the Spanish button). Baseline written before the data:
  // 7 of 344, 2.0%. Keep at or above 2%, change one thing at 1 to 2%, kill under 1%.
  // The click is a generic CTA row (assets/js/attribution.js), matched by label PREFIX because the
  // label carries a trailing arrow and is rewritten to "Processing…" mid-click.
  const paid = await one(env.DB,
    `WITH paid AS (
       SELECT id FROM analytics_sessions
        WHERE started_at >= ? AND started_at < ? AND COALESCE(device,'') != 'bot' AND region = 'Utah'
          AND (fbclid IS NOT NULL AND fbclid != '' OR LOWER(COALESCE(utm_source,'')) IN ('facebook','instagram','fb','ig'))
     )
     SELECT (SELECT COUNT(*) FROM paid) AS sessions,
            (SELECT COUNT(DISTINCT e.session_id) FROM analytics_events e JOIN paid p ON p.id = e.session_id
              WHERE e.type = 'cta' AND (e.label LIKE 'Continue to payment%' OR e.label LIKE 'Continuar con el pago%')) AS reached`,
    startIso, endIso).catch(() => null);
  lines.push('— paid-cohort checkout (the ad rule) —');
  if (!paid) lines.push('• could not compute (query failed); do not read this as zero');
  else if (!paid.sessions) lines.push('• no paid Utah sessions this week (ad off or nothing tagged)');
  else lines.push(`• ${paid.reached} of ${paid.sessions} paid Utah sessions reached "Continue to payment" = ${(100 * paid.reached / paid.sessions).toFixed(1)}% (baseline 2.0%; keep ≥2%, change one thing at 1–2%, kill <1%)`);

  // Referrals (board ruling 2026-09-14). The keep bar is 5 code-attributed new PAYING customers in 30
  // days, read on the 2026-10-18 lock; redemptions alone are free to generate and prove nothing.
  try {
    const rs = await referralStats(env, new Date(Date.now() - 30 * 86400000).toISOString());
    lines.push('Referrals, last 30 days:');
    lines.push(`• ${rs.window.paying} referred friends have PAID a first week (bar ${rs.window.bar} by 2026-10-18); ${rs.window.second_paid_week} reached a second paid week; ${rs.window.attributed} signed up through a link or code`);
    const cr = rs.credits_by_status || {};
    lines.push(`• credits to referrers: ${(cr.pending && cr.pending.n) || 0} pending, ${(cr.applied && cr.applied.n) || 0} applied ($${(((cr.applied && cr.applied.cents) || 0) / 100).toFixed(2)} off invoices); ${rs.codes_issued} customers hold a code`);
    if (rs.attributed.length) lines.push('• ' + rs.attributed.slice(0, 8).map((a) => `${a.friend || '?'} via ${a.referrer || a.code} (${a.paid_weeks} paid wk${a.paid_weeks === 1 ? '' : 's'})`).join('; '));
  } catch (e) {
    lines.push(`Referrals: could not compute (${String(e).slice(0, 80)}); do not read this as zero`);
  }

  lines.push('Full report with 7/30/90 day windows: /app/ops → Marketing → Channels.');
  await ownerNotify(env, 'owner_weekly_marketing', summary, { entity: 'system', lines, window: r.window });
  return ok({ summary, lines: lines.length, window: r.window });
}
