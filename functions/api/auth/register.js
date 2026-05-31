// POST /api/auth/register — create a customer account (password optional; they can use magic-link).
import { ok, fail, readJson } from '../../_lib/respond.js';
import { one, run, nowIso } from '../../_lib/db.js';
import { randomToken, hashPassword } from '../../_lib/crypto.js';
import { createSession } from '../../_lib/auth.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await readJson(request);
  const email = (body.email || '').trim().toLowerCase();
  const password = body.password || '';
  const firstName = (body.first_name || '').trim();
  const lastName = (body.last_name || '').trim();
  const phone = (body.phone || '').trim();

  if (!email || !email.includes('@')) return fail(400, 'invalid_email', 'Enter a valid email address.');
  if (password && password.length < 8) return fail(400, 'weak_password', 'Password must be at least 8 characters.');

  const existing = await one(env.DB, `SELECT id FROM customers WHERE email = ?`, email);
  if (existing) return fail(409, 'email_exists', 'An account with that email already exists — try logging in.');

  const id = randomToken(16);
  const now = nowIso();
  await run(
    env.DB,
    `INSERT INTO customers (id, email, first_name, last_name, phone, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'customer', ?, ?)`,
    id, email, firstName, lastName, phone, now, now,
  );

  if (password) {
    const { hash, salt, iterations } = await hashPassword(password);
    await run(
      env.DB,
      `INSERT INTO auth_passwords (customer_id, password_hash, salt, iterations, updated_at) VALUES (?, ?, ?, ?, ?)`,
      id, hash, salt, iterations, now,
    );
  }

  const { cookie } = await createSession(env, id, request);
  return ok({ customer: { id, email, first_name: firstName } }, { 'Set-Cookie': cookie });
}
