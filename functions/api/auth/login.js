// POST /api/auth/login — username/password login. Generic errors (never leak which emails exist).
import { ok, fail, readJson } from '../../_lib/respond.js';
import { one } from '../../_lib/db.js';
import { verifyPassword } from '../../_lib/crypto.js';
import { createSession } from '../../_lib/auth.js';
import { str, normEmail } from '../../_lib/validate.js';
import { rateLimit, clientIp } from '../../_lib/ratelimit.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await readJson(request);
  const email = normEmail(body.email);
  const password = str(body.password);
  if (!email || !password) return fail(400, 'missing_credentials', 'Enter your email and password.');

  // Brute-force throttle (per IP + per account) BEFORE the expensive PBKDF2 verify.
  const ip = clientIp(request);
  if (!(await rateLimit(env, `login:ip:${ip}`, 20, 900)) || !(await rateLimit(env, `login:email:${email}`, 8, 900))) {
    return fail(429, 'rate_limited', 'Too many attempts. Please wait a few minutes and try again.');
  }

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
