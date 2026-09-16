// POST /api/account/profile: a customer edits their own name and phone. Session-gated.
//   Body { first_name?, last_name?, phone? }   (send only what changes; phone '' clears it in D1.
//   GHL keeps its copy until a real number replaces it: ghlUpdatePhone ignores a null, on purpose.)
//
// Built 2026-09-16 (app redesign, slice one). Until now no customer endpoint wrote phone: the ops
// Customers tab could (admin/customer-edit.js), the customer could not, and notification-prefs
// refuses text consent when phone is empty, so the consent toggle on the new Account page needs
// this first. Validation and the GHL phone sync are the same as customer-edit.js so the two paths
// cannot drift: one E.164 normaliser (_lib/validate.js toE164), one best-effort ghlUpdatePhone
// with the Saturday phone-sync sweep as the catch-all.
import { ok, fail, readJson } from '../../_lib/respond.js';
import { run, nowIso } from '../../_lib/db.js';
import { getSessionCustomer } from '../../_lib/auth.js';
import { str, toE164 } from '../../_lib/validate.js';
import { ghlUpdatePhone } from '../../_lib/ghl.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = await getSessionCustomer(context);
  if (!auth) return fail(401, 'not_authenticated', 'Please log in.');
  const { customer } = auth;
  const body = (await readJson(request)) || {};

  const firstName = body.first_name !== undefined ? str(body.first_name).trim().slice(0, 80) : null;
  const lastName = body.last_name !== undefined ? str(body.last_name).trim().slice(0, 80) : null;
  if (firstName === '') return fail(400, 'no_first_name', 'First name cannot be empty.');

  let phone = null;
  if (body.phone !== undefined) {
    const raw = str(body.phone).trim();
    if (raw) { phone = toE164(raw); if (!phone) return fail(400, 'invalid_phone', 'Enter a valid phone number.'); }
    else phone = '';
  }
  if (firstName === null && lastName === null && phone === null) return fail(400, 'nothing_to_save', 'Nothing to save.');

  const now = nowIso();
  await run(env.DB,
    `UPDATE customers SET
       first_name = COALESCE(?, first_name),
       last_name  = COALESCE(?, last_name),
       phone      = CASE WHEN ? IS NULL THEN phone WHEN ? = '' THEN NULL ELSE ? END,
       updated_at = ? WHERE id = ?`,
    firstName, lastName, phone, phone, phone, now, customer.id);

  const changed = [];
  if (firstName !== null || lastName !== null) changed.push('name');
  if (phone !== null) changed.push('phone');
  if (phone !== null && customer.ghl_contact_id) {
    try { await ghlUpdatePhone(env, customer.ghl_contact_id, phone || null); } catch { /* the Saturday phone-sync sweep catches it */ }
  }
  return ok({ changed, first_name: firstName ?? customer.first_name, last_name: lastName ?? customer.last_name, phone: phone === null ? (customer.phone || null) : (phone || null) });
}
