// GET /api/admin/channel-report?days=7|30|90&end=YYYY-MM-DD — the weekly marketing answer, sliced by
// CHANNEL over a real time window. Two tables, never merged (show the dissenter):
//   by_first_touch    what the visitor's browser said (utm / click-id / referrer host), classified by
//                     _lib/channels.js classify() on the WHOLE row
//   by_self_reported  what the customer typed at signup
// Money: "new paying" = customers whose FIRST succeeded payment lands in the window; revenue = all
// succeeded payments in the window by the paying customer's first-touch channel. Spend joins by
// marketing_spend.channel (meta -> meta-ads, google -> google-ads). CAC is null, never 0, when spend
// is 0 in the window; `end` exists so the spend join can be tested on the July 15 - Aug 15 window
// where the only spend rows live. Owner-only (admin token also accepted).
import { ok, fail } from '../../_lib/respond.js';
import { requireOwner } from '../../_lib/admin.js';
import { all } from '../../_lib/db.js';
import { CHANNELS, classify, selfReportedToChannel } from '../../_lib/channels.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function buildChannelReport(db, { days = 7, end = null } = {}) {
  const d = [7, 30, 90].includes(days) ? days : 7;
  const endDay = end && DATE_RE.test(end) ? end : new Date().toISOString().slice(0, 10);
  const endExcl = new Date(`${endDay}T00:00:00Z`); endExcl.setUTCDate(endExcl.getUTCDate() + 1);
  const start = new Date(endExcl); start.setUTCDate(start.getUTCDate() - d);
  const startIso = start.toISOString(), endIso = endExcl.toISOString();
  const startDay = startIso.slice(0, 10);

  // Sessions (bots out), grouped by the classifier's inputs so classify() runs per group, not per row.
  const sess = await all(db,
    `SELECT utm_source, utm_medium, entry_referrer_host AS referrer_host, ad_id, fbclid, gclid, COUNT(*) AS n
       FROM analytics_sessions
      WHERE started_at >= ? AND started_at < ? AND COALESCE(device,'') != 'bot'
      GROUP BY 1,2,3,4,5,6`, startIso, endIso);

  // Every attribution row (small table) so a customer who signed up before the window but first paid
  // inside it still has a channel.
  const attrAll = await all(db,
    `SELECT customer_id, utm_source, utm_medium, referrer, ad_id, fbclid, gclid, self_reported, created_at FROM attribution`);
  const attrBy = new Map();
  for (const a of attrAll) if (!attrBy.has(a.customer_id)) attrBy.set(a.customer_id, a);

  const firstPaid = await all(db,
    `SELECT customer_id, MIN(created_at) AS first_paid FROM payments
      WHERE status = 'succeeded' AND amount_cents > 0 GROUP BY customer_id`);
  const revWin = await all(db,
    `SELECT customer_id, SUM(amount_cents) AS rev FROM payments
      WHERE status = 'succeeded' AND amount_cents > 0 AND created_at >= ? AND created_at < ? GROUP BY customer_id`, startIso, endIso);
  const spend = await all(db,
    `SELECT channel, SUM(spend_cents) AS cents FROM marketing_spend WHERE day >= ? AND day < ? GROUP BY channel`, startDay, endDay);

  const blank = () => ({ sessions: 0, signups: 0, new_paying: 0, revenue_cents: 0, spend_cents: 0 });
  const ft = {}; const sr = {};
  const row = (map, k) => (map[k] = map[k] || { channel: k, ...blank() });

  for (const s of sess) row(ft, classify(s)).sessions += s.n;
  for (const a of attrAll) {
    if (a.created_at >= startIso && a.created_at < endIso) {
      row(ft, classify(a)).signups++;
      row(sr, selfReportedToChannel(a.self_reported)).signups++;
    }
  }
  for (const p of firstPaid) {
    if (p.first_paid >= startIso && p.first_paid < endIso) {
      const a = attrBy.get(p.customer_id);
      row(ft, a ? classify(a) : 'unattributed').new_paying++;
      row(sr, a ? selfReportedToChannel(a.self_reported) : '(blank)').new_paying++;
    }
  }
  for (const r of revWin) {
    const a = attrBy.get(r.customer_id);
    row(ft, a ? classify(a) : 'unattributed').revenue_cents += r.rev || 0;
    row(sr, a ? selfReportedToChannel(a.self_reported) : '(blank)').revenue_cents += r.rev || 0;
  }
  const spendChannel = (c) => ({ meta: 'meta-ads', google: 'google-ads', marketplace: 'marketplace', tiktok: 'tiktok', gbp: 'google' }[String(c || '').toLowerCase()] || 'other');
  for (const s of spend) row(ft, spendChannel(s.channel)).spend_cents += s.cents || 0;

  const finish = (r) => ({
    ...r,
    cac_cents: r.spend_cents > 0 && r.new_paying > 0 ? Math.round(r.spend_cents / r.new_paying) : null,
    revenue_per_dollar: r.spend_cents > 0 ? Math.round((r.revenue_cents / r.spend_cents) * 100) / 100 : null,
    spend_note: r.spend_cents > 0 ? null : 'no spend in window',
  });
  const order = (a, b) => (CHANNELS.indexOf(a.channel) === -1 ? 99 : CHANNELS.indexOf(a.channel)) - (CHANNELS.indexOf(b.channel) === -1 ? 99 : CHANNELS.indexOf(b.channel));
  const totals = (rows) => rows.reduce((t, r) => ({ sessions: t.sessions + r.sessions, signups: t.signups + r.signups, new_paying: t.new_paying + r.new_paying, revenue_cents: t.revenue_cents + r.revenue_cents, spend_cents: t.spend_cents + r.spend_cents }), blank());
  const byFirst = Object.values(ft).map(finish).sort(order);
  const bySelf = Object.values(sr).map(finish).sort((a, b) => b.signups - a.signups);

  return {
    window: { days: d, start: startDay, end: endDay },
    by_first_touch: byFirst,
    by_self_reported: bySelf,
    totals: { first_touch: totals(byFirst), self_reported: totals(bySelf) },
    notes: [
      'first_touch = what the browser carried (utm, click id, referrer host), bots excluded; self_reported = what the customer typed at signup. Both shown, never merged: self-reported over-counts social (includes organic posts) and under-counts search.',
      'new_paying = first successful payment in the window; revenue = all successful payments in the window by that customer\'s channel.',
      'CAC is null when spend in the window is 0. Meta spend syncs nightly; there is no Google spend feed yet.',
      'facebook (before split) = signups before 2026-09-02, when one Facebook option covered ads, Marketplace and posts.',
    ],
  };
}

export async function onRequestGet(context) {
  const denied = await requireOwner(context);
  if (denied) return denied;
  const u = new URL(context.request.url);
  const days = parseInt(u.searchParams.get('days') || '7', 10);
  const end = u.searchParams.get('end');
  if (end && !DATE_RE.test(end)) return fail(400, 'bad_end', 'end must be YYYY-MM-DD');
  const report = await buildChannelReport(context.env.DB, { days, end });
  return ok(report);
}
