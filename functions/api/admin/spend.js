// /api/admin/spend — manual ad-spend log (staff-or-admin). The Phase 1 bridge until Phase 2 pulls
// spend from the Meta/Google APIs nightly: log what you spent per day per channel, and the Marketing
// funnel can compute real CPL/CAC. GET: recent entries + per-channel totals. POST: add one entry
// { day: 'YYYY-MM-DD', channel: meta|google|gbp|tiktok|marketplace|other, spend: dollars, campaign?, notes? }
import { ok, fail, readJson } from '../../_lib/respond.js';
import { requireOwner } from '../../_lib/admin.js';
import { all, run, nowIso } from '../../_lib/db.js';

const CHANNELS = new Set(['meta', 'google', 'gbp', 'tiktok', 'marketplace', 'other']);

export async function onRequestGet(context) {
  const denied = await requireOwner(context);
  if (denied) return denied;
  const entries = await all(context.env.DB,
    `SELECT id, day, channel, campaign, spend_cents, notes FROM marketing_spend ORDER BY day DESC, id DESC LIMIT 200`);
  const totals = await all(context.env.DB,
    `SELECT channel, SUM(spend_cents) AS total_cents,
            SUM(CASE WHEN day >= date('now', '-30 day') THEN spend_cents ELSE 0 END) AS last30_cents
     FROM marketing_spend GROUP BY channel ORDER BY total_cents DESC`);
  return ok({ entries, totals });
}

export async function onRequestPost(context) {
  const denied = await requireOwner(context);
  if (denied) return denied;
  const b = await readJson(context.request);
  const day = String(b.day || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return fail(400, 'bad_day', 'day must be YYYY-MM-DD');
  const channel = String(b.channel || '').toLowerCase().trim();
  if (!CHANNELS.has(channel)) return fail(400, 'bad_channel', `channel must be one of: ${[...CHANNELS].join(', ')}`);
  const spendCents = Math.round(Number(b.spend) * 100);
  if (!Number.isFinite(spendCents) || spendCents < 0 || spendCents > 5_000_000) {
    return fail(400, 'bad_spend', 'spend must be a dollar amount between 0 and 50000');
  }
  await run(context.env.DB,
    `INSERT INTO marketing_spend (day, channel, campaign, spend_cents, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    day, channel, String(b.campaign || '').slice(0, 120) || null, spendCents,
    String(b.notes || '').slice(0, 300) || null, nowIso());
  return ok({ logged: { day, channel, spend_cents: spendCents } });
}
