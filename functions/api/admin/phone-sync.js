// GET  /api/admin/phone-sync        report: who has a phone in D1 that GHL does not know about
// POST /api/admin/phone-sync        repair: push those phones onto their GHL contacts
//
// WHY. On 2026-08-30, 4 of 20 pickup customers (20%) had a phone in D1 and none on their GHL
// contact, so every text to them failed as "no phone on file". Their numbers were written across
// by hand that day; this endpoint is the fix for the class. The gap exists because
// ghlEnsureContact only runs for customers with no contact id yet: a contact created before the
// customer had a phone never learns it, and nothing reconciled the two stores.
//
// The cron Worker POSTs this every Saturday, so phones are synced BEFORE Sunday's pickup texts,
// which is "a check that flags the gap before a send rather than after".
//
// Reads one GHL contact per phone-holding customer, so it is batched and capped well under the
// Workers subrequest limit. At ~27 customers one pass covers everyone; if the cap is ever hit the
// response says truncated:true and the next run finishes the job.
import { json } from '../../_lib/respond.js';
import { all, one, run, nowIso } from '../../_lib/db.js';
import { requireAdmin } from '../../_lib/admin.js';
import { ghlGetContact, ghlUpdatePhone, ghlEnsureContact } from '../../_lib/ghl.js';

const MAX_LOOKUPS = 40; // stay clearly under the subrequest cap, PUTs included
const BATCH = 5;
const CURSOR_KEY = 'phone_sync_cursor';

// Where a truncated sweep left off, kept in ops_kv so the next run CONTINUES instead of re-checking
// the same first 40 customers forever (the bug the first version of this file shipped with: anyone
// past the cap was never looked at). Wraps to the start when the end is reached.
async function readCursor(env) {
  try {
    const row = await one(env.DB, `SELECT value_json FROM ops_kv WHERE key = ?`, CURSOR_KEY);
    return row ? (JSON.parse(row.value_json || '""') || '') : '';
  } catch { return ''; }
}
async function writeCursor(env, v) {
  try {
    await run(env.DB,
      `INSERT INTO ops_kv (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      CURSOR_KEY, JSON.stringify(v || ''), nowIso());
  } catch { /* non-fatal: worst case the next sweep re-checks a stretch */ }
}

async function sweep(env, repair) {
  // Only the repair path (the Saturday cron) advances the cursor. A hand-run GET report always
  // shows from the top and must not shift where the weekly sweep resumes.
  const cursor = repair ? await readCursor(env) : '';
  // Start after the cursor; wrap the remainder to the front so one ordering covers everyone.
  const after = await all(env.DB,
    `SELECT id, email, first_name, last_name, phone, ghl_contact_id, created_at
       FROM customers WHERE phone IS NOT NULL AND phone != '' AND created_at > ? ORDER BY created_at`, cursor);
  const before = await all(env.DB,
    `SELECT id, email, first_name, last_name, phone, ghl_contact_id, created_at
       FROM customers WHERE phone IS NOT NULL AND phone != '' AND created_at <= ? ORDER BY created_at`, cursor);
  const customers = [...after, ...before];

  const missing = [], pushed = [], noContact = [], errors = [];
  let looked = 0, truncated = false, lastChecked = cursor;

  for (let i = 0; i < customers.length; i += BATCH) {
    if (looked >= MAX_LOOKUPS) { truncated = true; break; }
    const slice = customers.slice(i, i + BATCH);
    lastChecked = slice[slice.length - 1].created_at;
    await Promise.all(slice.map(async (c) => {
      const who = { id: c.id, name: `${c.first_name || ''} ${c.last_name || ''}`.trim(), email: c.email };
      try {
        if (!c.ghl_contact_id) {
          // No contact at all: ensure creates it WITH the phone, which repairs in one step.
          if (repair) {
            const cid = await ghlEnsureContact(env, { email: c.email, firstName: c.first_name, lastName: c.last_name, phone: c.phone });
            if (cid) {
              try { await run(env.DB, `UPDATE customers SET ghl_contact_id = ?, updated_at = ? WHERE id = ?`, cid, nowIso(), c.id); } catch { /* non-fatal */ }
              pushed.push({ ...who, how: 'contact_created' });
            } else errors.push({ ...who, why: 'ensure_contact_failed' });
          } else noContact.push(who);
          looked += 1;
          return;
        }
        const contact = await ghlGetContact(env, c.ghl_contact_id);
        looked += 1;
        if (!contact) { errors.push({ ...who, why: 'ghl_contact_unreadable' }); return; }
        if (!contact.phone) {
          if (repair) {
            const okPut = await ghlUpdatePhone(env, c.ghl_contact_id, c.phone);
            if (okPut) pushed.push({ ...who, how: 'phone_pushed' });
            else errors.push({ ...who, why: 'phone_push_failed' });
          } else missing.push(who);
        }
      } catch (e) {
        errors.push({ ...who, why: String(e).slice(0, 120) });
      }
    }));
  }

  // Full pass completed: reset so the next run starts at the top. Truncated: continue from here.
  if (repair) await writeCursor(env, truncated ? lastChecked : '');

  return {
    checked: looked,
    total_with_phone: customers.length,
    truncated,
    cursor_resumes_after: truncated ? lastChecked : null,
    missing_in_ghl: missing,
    no_ghl_contact: noContact,
    pushed,
    errors,
    counts: { missing: missing.length, no_contact: noContact.length, pushed: pushed.length, errors: errors.length },
  };
}

export async function onRequestGet(context) {
  const denied = await requireAdmin(context); if (denied) return denied;
  return json({ ok: true, mode: 'report', ...(await sweep(context.env, false)) }, 200);
}

export async function onRequestPost(context) {
  const denied = await requireAdmin(context); if (denied) return denied;
  const result = await sweep(context.env, true);
  // The repair leaves an audit trail: silent fleet-wide writes are how mystery data happens.
  try {
    if (result.counts.pushed || result.counts.errors) {
      await run(context.env.DB,
        `INSERT INTO audit_log (at, actor, entity, action, detail_json) VALUES (?, 'admin', 'system', 'phone_sync', ?)`,
        nowIso(), JSON.stringify(result.counts));
    }
  } catch { /* non-fatal */ }
  return json({ ok: true, mode: 'repair', ...result }, 200);
}
