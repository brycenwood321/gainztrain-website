// Staff-gated shared key/value store for the prep dashboard.
//   GET  /api/admin/ops-store?key=meal_library   → { key, value }   (value parsed from JSON; [] if unset)
//   POST /api/admin/ops-store   { key, value }    → { ok, key }      (upserts value as JSON)
// Backs the meal library + custom ingredients so they're durable + shared across every staff member and
// device (localStorage was per-browser and lost meals on a device switch). Keys are whitelisted so this
// can't become an open data dump. Auth: requireStaffOrAdmin (session cookie or admin token).
import { json, fail } from '../../_lib/respond.js';
import { requireStaffOrAdmin, requireOwner } from '../../_lib/admin.js';
import { one, run, nowIso } from '../../_lib/db.js';

const ALLOWED = new Set(['meal_library', 'custom_ingredients', 'ingredient_library']);
// Keys whose WRITES are owner-only (reads stay staff-level so the kitchen shopping list can use them).
// The ingredient library drives shopping-list quantities + costs, so only owners may edit it.
const OWNER_WRITE = new Set(['ingredient_library']);
// Per-week menu drafts (menu_week_YYYYMMDD) also sync here so the Menu + Ingredients tabs populate on any
// device (phone), not just the laptop the menu was built on.
const MENU_DRAFT_RE = /^menu_week_\d{8}$/;
// The kitchen's shared working order list for a week (pulled + manually-added + meal-swap edits), so
// every staff device sees the same orders — not just the phone that pulled/added them. Staff-writable.
const PREP_ORDERS_RE = /^prep_orders_\d{8}$/;
const keyAllowed = (k) => ALLOWED.has(k) || MENU_DRAFT_RE.test(k) || PREP_ORDERS_RE.test(k);
const MAX_BYTES = 800000; // generous ceiling; the meal catalog is small JSON

export async function onRequestGet(context) {
  const denied = await requireStaffOrAdmin(context);
  if (denied) return denied;
  const key = new URL(context.request.url).searchParams.get('key') || '';
  if (!keyAllowed(key)) return fail(400, 'bad_key', 'Unknown store key.');
  const row = await one(context.env.DB, `SELECT value_json FROM ops_kv WHERE key = ?`, key);
  let value = [];
  if (row && row.value_json) { try { value = JSON.parse(row.value_json); } catch { value = []; } }
  return json({ key, value });
}

export async function onRequestPost(context) {
  let body;
  try { body = await context.request.json(); } catch { return fail(400, 'bad_json', 'Body must be JSON.'); }
  const key = String(body.key || '');
  if (!keyAllowed(key)) return fail(400, 'bad_key', 'Unknown store key.');
  // Owner-only keys (ingredient library) require owner; everything else is staff-writable.
  const denied = OWNER_WRITE.has(key) ? await requireOwner(context) : await requireStaffOrAdmin(context);
  if (denied) return denied;
  if (!('value' in body)) return fail(400, 'no_value', 'Missing value.');
  const valueJson = JSON.stringify(body.value);
  if (valueJson.length > MAX_BYTES) return fail(413, 'too_large', 'Store value too large.');
  await run(context.env.DB,
    `INSERT INTO ops_kv (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`,
    key, valueJson, nowIso());
  return json({ ok: true, key });
}
