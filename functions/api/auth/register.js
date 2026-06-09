// POST /api/auth/register — create a customer account (password optional; they can use magic-link).
import { ok, fail, readJson } from '../../_lib/respond.js';
import { one, run, nowIso } from '../../_lib/db.js';
import { randomToken, hashPassword } from '../../_lib/crypto.js';
import { createSession } from '../../_lib/auth.js';
import { notify } from '../../_lib/notify.js';
import { str, normEmail, toE164 } from '../../_lib/validate.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await readJson(request);
  // Type-safe coercion: a non-string value can never reach a string method (no 500 leak) and
  // a non-string password can never silently corrupt the stored hash.
  const email = normEmail(body.email);
  const password = str(body.password);
  const firstName = str(body.first_name).trim();
  const lastName = str(body.last_name).trim();
  const phoneRaw = str(body.phone).trim();

  if (!email || !email.includes('@')) return fail(400, 'invalid_email', 'Enter a valid email address.');
  if (password && password.length < 8) return fail(400, 'weak_password', 'Password must be at least 8 characters.');
  // Normalize phone to E.164 so it matches the OTP-login lookup; reject garbage rather than store it.
  const phone = phoneRaw ? toE164(phoneRaw) : '';
  if (phoneRaw && !phone) return fail(400, 'invalid_phone', 'Enter a valid phone number.');

  const existing = await one(env.DB, `SELECT id FROM customers WHERE email = ?`, email);
  if (existing) return fail(409, 'email_exists', 'An account with that email already exists — try logging in.');

  const id = randomToken(16);
  const now = nowIso();
  try {
    await run(
      env.DB,
      `INSERT INTO customers (id, email, first_name, last_name, phone, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'customer', ?, ?)`,
      id, email, firstName, lastName, phone || null, now, now,
    );
  } catch {
    // UNIQUE(email) race: another request registered the same email between our check + insert.
    return fail(409, 'email_exists', 'An account with that email already exists — try logging in.');
  }

  try {
    if (password) {
      const { hash, salt, iterations } = await hashPassword(password);
      await run(
        env.DB,
        `INSERT INTO auth_passwords (customer_id, password_hash, salt, iterations, updated_at) VALUES (?, ?, ?, ?, ?)`,
        id, hash, salt, iterations, now,
      );
    }
    const { cookie } = await createSession(env, id, request);
    // Welcome email through notify() (branded template, leak-proof path; lazily links a GHL contact so
    // future magic links can reach them). Non-blocking — a comms hiccup must never fail the signup.
    try {
      await notify(env, { id, email, first_name: firstName, last_name: lastName, phone, ghl_contact_id: null },
        'welcome', { firstName, hasPassword: !!password });
    } catch { /* non-fatal */ }
    return ok({ customer: { id, email, first_name: firstName } }, { 'Set-Cookie': cookie });
  } catch {
    // Defensive: never let a hashing/session error become a raw 1101. The customer row exists;
    // they can set a password via magic-link if this ever fires.
    return fail(500, 'register_failed', 'Could not finish creating your account. Try again.');
  }
}
