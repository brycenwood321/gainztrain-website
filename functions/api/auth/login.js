// POST /api/auth/login — username/password login. Generic errors (never leak which emails exist).
import { ok, fail, readJson } from '../../_lib/respond.js';
import { one } from '../../_lib/db.js';
import { verifyPassword } from '../../_lib/crypto.js';
import { createSession } from '../../_lib/auth.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await readJson(request);
  const email = (body.email || '').trim().toLowerCase();
  const password = body.password || '';
  if (!email || !password) return fail(400, 'missing_credentials', 'Enter your email and password.');

  const generic = () => fail(401, 'invalid_login', 'Email or password is incorrect.');
  const customer = await one(env.DB, `SELECT id, email FROM customers WHERE email = ?`, email);
  if (!customer) {
    // Spend ~equal time so attackers can't tell registered emails apart by timing.
    await verifyPassword(password, '00', '0'.repeat(64)).catch(() => {});
    return generic();
  }

  const pw = await one(env.DB, `SELECT password_hash, salt, iterations FROM auth_passwords WHERE customer_id = ?`, customer.id);
  if (!pw) return generic();
  const valid = await verifyPassword(password, pw.salt, pw.password_hash, pw.iterations);
  if (!valid) return generic();

  const { cookie } = await createSession(env, customer.id, request);
  return ok({ customer: { id: customer.id, email: customer.email } }, { 'Set-Cookie': cookie });
}
