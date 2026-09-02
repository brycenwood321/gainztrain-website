// POST /api/admin/marketing-weekly — the Monday "marketing week" owner email. Cron hits it in the Monday
// block of cron/worker.js. Email-only (not in owner_notify BIG): it is a report, not a page. When spend
// was zero it says so in words; a null CAC is not a number anyone should read on a phone.
import { ok } from '../../_lib/respond.js';
import { requireAdmin } from '../../_lib/admin.js';
import { ownerNotify } from '../../_lib/owner_notify.js';
import { buildChannelReport } from './channel-report.js';

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
  lines.push('Full report with 7/30/90 day windows: /app/ops → Marketing → Channels.');
  await ownerNotify(env, 'owner_weekly_marketing', summary, { entity: 'system', lines, window: r.window });
  return ok({ summary, lines: lines.length, window: r.window });
}
