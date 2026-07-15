// Delivery ZIP management for the /ops Settings tab. Owner-gated.
//   GET  /api/admin/delivery-zips          -> { zones:[{zone,name,fee_cents}], zips:[{zip,zone}] }
//   POST /api/admin/delivery-zips  { zip, zone }            -> add/move a ZIP into a delivery zone
//   POST /api/admin/delivery-zips  { zip, remove:true }     -> stop serving a ZIP
// Adding a ZIP here is all it takes for a customer in that area to check out with delivery (the
// /api/delivery-quote + address flows read zip_zone_map live).
import { ok, fail, readJson } from '../../_lib/respond.js';
import { requireOwner } from '../../_lib/admin.js';
import { one, all, run, nowIso } from '../../_lib/db.js';

export async function onRequestGet(context) {
  const denied = await requireOwner(context);
  if (denied) return denied;
  const zones = await all(context.env.DB, `SELECT zone, name, fee_cents FROM delivery_zones ORDER BY zone`);
  const zips = await all(context.env.DB, `SELECT zip, zone FROM zip_zone_map ORDER BY zone, zip`);
  return ok({ zones, zips });
}

export async function onRequestPost(context) {
  const { env } = context;
  const denied = await requireOwner(context);
  if (denied) return denied;

  const body = await readJson(context.request);
  const zip = String(body.zip || '').replace(/[^0-9]/g, '').slice(0, 5);
  if (zip.length !== 5) return fail(400, 'invalid_zip', 'Enter a valid 5-digit ZIP.');
  const now = nowIso();

  if (body.remove === true) {
    await run(env.DB, `DELETE FROM zip_zone_map WHERE zip = ?`, zip);
    try { await run(env.DB, `INSERT INTO audit_log (at, actor, entity, action, detail_json) VALUES (?, 'owner', ?, 'zip_removed', ?)`, now, `zip:${zip}`, JSON.stringify({ zip })); } catch { /* non-fatal */ }
    return ok({ zip, removed: true });
  }

  const zone = Number(body.zone);
  if (!Number.isInteger(zone)) return fail(400, 'invalid_zone', 'Pick a delivery zone.');
  const zoneRow = await one(env.DB, `SELECT zone, name, fee_cents FROM delivery_zones WHERE zone = ?`, zone);
  if (!zoneRow) return fail(400, 'unknown_zone', 'That zone does not exist.');

  await run(env.DB,
    `INSERT INTO zip_zone_map (zip, zone) VALUES (?, ?)
     ON CONFLICT(zip) DO UPDATE SET zone = excluded.zone`,
    zip, zone);
  try { await run(env.DB, `INSERT INTO audit_log (at, actor, entity, action, detail_json) VALUES (?, 'owner', ?, 'zip_added', ?)`, now, `zip:${zip}`, JSON.stringify({ zip, zone })); } catch { /* non-fatal */ }
  return ok({ zip, zone, zone_name: zoneRow.name, fee_cents: zoneRow.fee_cents });
}
