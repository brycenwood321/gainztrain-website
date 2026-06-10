// POST /api/auth/set-password — set or change the logged-in customer's password.
// Session-gated. This is the recovery destination: forgot password → magic link → (logged in) →
// set a new password here. Also lets a passwordless signup add a password.
import { ok, fail, readJson } from '../../_lib/respond.js';
import { run, nowIso } from '../../_lib/db.js';
import { getSessionCustomer } from '../../_lib/auth.js';
import { hashPassword } from '../../_lib/crypto.js';
import { str } from '../../_lib/validate.js';
import { notify } from '../../_lib/notify.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = await getSessionCustomer(context);
  if (!auth) return fail(401, 'not_authenticated', 'Please log in.');

  const password = str((await readJson(request)).password);
  if (password.length < 8) return fail(400, 'weak_password', 'Password must be at least 8 characters.');

  const { hash, salt, iterations } = await hashPassword(password);
  await run(env.DB,
    `INSERT INTO auth_passwords (customer_id, password_hash, salt, iterations, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(customer_id) DO UPDATE SET password_hash=excluded.password_hash, salt=excluded.salt,
       iterations=excluded.iterations, updated_at=excluded.updated_at`,
    auth.customer.id, hash, salt, iterations, nowIso());
  // A password change kicks out everyone else: revoke all OTHER sessions + burn any unused magic links
  // (so a hijacked-but-unused reset link can't be replayed after the legit owner resets).
  try {
    await run(env.DB, `UPDATE sessions SET revoked_at = ? WHERE customer_id = ? AND id <> ? AND revoked_at IS NULL`, nowIso(), auth.customer.id, auth.session.id);
    await run(env.DB, `UPDATE auth_tokens SET consumed_at = ? WHERE customer_id = ? AND kind = 'magic_link' AND consumed_at IS NULL`, nowIso(), auth.customer.id);
  } catch { /* non-fatal */ }
  // Security alarm: the reset path is a magic link, so this email is the customer's only signal if a
  // link was ever hijacked. Non-blocking — a comms hiccup must not fail the password change.
  try { await notify(env, auth.customer, 'password_changed'); } catch { /* non-fatal */ }
  return ok({});
}
