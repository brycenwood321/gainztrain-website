// POST /api/auth/verify-sms-otp — check a 6-digit code, lock out after 5 wrong tries.
import { ok, fail, readJson } from '../../_lib/respond.js';
import { one, run, nowIso } from '../../_lib/db.js';
import { sha256hex } from '../../_lib/crypto.js';
import { createSession } from '../../_lib/auth.js';

function toE164(raw) {
  const digits = (raw || '').replace(/[^0-9]/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return raw.startsWith('+') ? raw : `+${digits}`;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (env.SMS_AUTH_ENABLED !== 'true') {
    return fail(503, 'sms_unavailable', "Text-code login isn't available yet — use email or password.");
  }

  const body = await readJson(request);
  const phone = toE164(body.phone);
  const code = (body.code || '').replace(/[^0-9]/g, '');
  if (!phone || code.length !== 6) return fail(400, 'invalid_input', 'Enter the 6-digit code.');

  const customer = await one(env.DB, `SELECT id FROM customers WHERE phone = ?`, phone);
  if (!customer) return fail(401, 'invalid_code', 'That code is incorrect or expired.');

  const tokenHash = await sha256hex(`${code}:${phone}`);
  const now = nowIso();
  const row = await one(
    env.DB,
    `SELECT * FROM auth_tokens WHERE customer_id = ? AND kind = 'sms_otp' AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    customer.id,
  );
  if (!row || row.expires_at < now || row.attempts >= 5) {
    return fail(401, 'invalid_code', 'That code is incorrect or expired.');
  }

  if (row.token_hash !== tokenHash) {
    await run(env.DB, `UPDATE auth_tokens SET attempts = attempts + 1 WHERE id = ?`, row.id);
    return fail(401, 'invalid_code', 'That code is incorrect or expired.');
  }

  await run(env.DB, `UPDATE auth_tokens SET consumed_at = ? WHERE id = ?`, now, row.id);
  const { cookie } = await createSession(env, customer.id, request);
  return ok({ customer: { id: customer.id } }, { 'Set-Cookie': cookie });
}
