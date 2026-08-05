// /api/admin/marketing-variants — the ad registry (owner-only).
//
// One row per ad, keyed on the Meta ad_id the visitor carries in. This is where offer / hook /
// audience / creative_type / target_region actually live: the ad itself carries only identifiers, so
// reports JOIN here rather than parsing UTM strings. Adding a new dimension means adding a column
// here, not migrating the hot analytics path.
//
// GET  -> all variants, newest first
// POST -> upsert one variant by `key` (Meta ad_id). Send only the fields you want to change.
import { ok, fail, readJson } from '../../_lib/respond.js';
import { requireOwner } from '../../_lib/admin.js';
import { all, run, nowIso } from '../../_lib/db.js';

const FIELDS = ['channel', 'platform', 'campaign', 'ad_name', 'hook', 'creative_type', 'offer',
  'audience', 'landing_path', 'landing_variant', 'status', 'target_region',
  'launched_at', 'retired_at', 'notes'];
const STATUSES = new Set(['draft', 'live', 'paused', 'retired']);

export async function onRequestGet(context) {
  const denied = await requireOwner(context);
  if (denied) return denied;
  const variants = await all(context.env.DB,
    `SELECT key, channel, platform, campaign, ad_name, hook, creative_type, offer, audience,
            landing_path, landing_variant, status, target_region, launched_at, retired_at, notes
       FROM marketing_variants
      ORDER BY CASE status WHEN 'live' THEN 0 WHEN 'draft' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
               launched_at DESC`);
  return ok({ variants });
}

export async function onRequestPost(context) {
  const denied = await requireOwner(context);
  if (denied) return denied;
  const b = await readJson(context.request);
  const key = String(b.key || '').trim().slice(0, 120);
  if (!key) return fail(400, 'key_required', 'key is required (use the Meta ad_id where one exists).');
  if (b.status && !STATUSES.has(String(b.status))) {
    return fail(400, 'bad_status', `status must be one of: ${[...STATUSES].join(', ')}`);
  }

  // Upsert. Only the keys actually present are written, so a partial edit never blanks other fields.
  const present = FIELDS.filter((f) => b[f] !== undefined);
  const clip = (v) => (v === null || v === '' ? null : String(v).slice(0, 400));
  const insertCols = ['key', ...present, 'created_at'];
  const placeholders = insertCols.map(() => '?').join(', ');
  const updates = present.length
    ? present.map((f) => `${f}=excluded.${f}`).join(', ')
    : 'key=key'; // no-op update keeps the statement valid when only `key` was sent

  await run(context.env.DB,
    `INSERT INTO marketing_variants (${insertCols.join(', ')}) VALUES (${placeholders})
     ON CONFLICT(key) DO UPDATE SET ${updates}`,
    key, ...present.map((f) => clip(b[f])), nowIso());

  return ok({ saved: key, fields: present });
}
