// POST /api/admin/set-staff — grant/revoke STAFF (backend/ops) access on an account, and optionally set
// a login password. Admin-token only (NOT staff-session — a staff member must not be able to promote
// others). Creates the customer if the email isn't on file yet (e.g. Marissa, who had no account).
//   Body { email, staff?=true, first_name?, last_name?, phone?, password? }
import { ok, fail, readJson } from '../../_lib/respond.js';
import { requireOwner } from '../../_lib/admin.js';
import { one, run, nowIso } from '../../_lib/db.js';
import { randomToken, hashPassword } from '../../_lib/crypto.js';
import { str, normEmail, toE164 } from '../../_lib/validate.js';

export async function onRequestPost(context) {
  const { env } = context;
  const denied = await requireOwner(context);
  if (denied) return denied;

  const body = await readJson(context.request);
  const email = normEmail(body.email);
  if (!email || !email.includes('@')) return fail(400, 'invalid_email', 'Valid email required.');
  const staff = body.staff !== false; // default true
  const role = staff ? 'staff' : 'customer';
  const firstName = str(body.first_name).trim();
  const lastName = str(body.last_name).trim();
  const phoneRaw = str(body.phone).trim();
  const phone = phoneRaw ? toE164(phoneRaw) : '';
  if (phoneRaw && !phone) return fail(400, 'invalid_phone', 'Enter a valid phone number.');
  const password = str(body.password);
  if (password && password.length < 8) return fail(400, 'weak_password', 'Password must be at least 8 characters.');

  const now = nowIso();
  let row = await one(env.DB, `SELECT id, role FROM customers WHERE email = ?`, email);
  let created = false;
  if (!row) {
    const id = randomToken(16);
    try {
      await run(env.DB,
        `INSERT INTO customers (id, email, first_name, last_name, phone, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id, email, firstName, lastName, phone || null, role, now, now);
    } catch { return fail(409, 'race', 'Email just got created — retry.'); }
    row = { id, role };
    created = true;
  } else {
    await run(env.DB,
      `UPDATE customers SET role=?, first_name=COALESCE(NULLIF(?,''),first_name),
         last_name=COALESCE(NULLIF(?,''),last_name), phone=COALESCE(NULLIF(?,''),phone), updated_at=? WHERE id=?`,
      role, firstName, lastName, phone, now, row.id);
  }

  let passwordSet = false;
  if (password) {
    const { hash, salt, iterations } = await hashPassword(password);
    await run(env.DB,
      `INSERT INTO auth_passwords (customer_id, password_hash, salt, iterations, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(customer_id) DO UPDATE SET password_hash=excluded.password_hash,
         salt=excluded.salt, iterations=excluded.iterations, updated_at=excluded.updated_at`,
      row.id, hash, salt, iterations, now);
    passwordSet = true;
  }

  try { await run(env.DB, `INSERT INTO audit_log (at, actor, entity, action, detail_json) VALUES (?, 'admin', ?, 'set_staff', ?)`,
    now, `customer:${row.id}`, JSON.stringify({ email, role, created, passwordSet })); } catch { /* non-fatal */ }

  return ok({ customer_id: row.id, email, role, created, password_set: passwordSet });
}
