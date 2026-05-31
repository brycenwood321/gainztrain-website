// POST /api/auth/request-sms-otp — text a 6-digit login code.
// BUILT but gated behind SMS_AUTH_ENABLED until GT's A2P carrier registration clears.
import { ok, fail, readJson } from '../../_lib/respond.js';
import { one, all, run, nowIso, addMinutesIso } from '../../_lib/db.js';
import { randomToken, randomDigits, sha256hex } from '../../_lib/crypto.js';
import { ghlSend } from '../../_lib/ghl.js';

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
  if (!phone) return fail(400, 'invalid_phone', 'Enter a valid phone number.');

  const generic = (extra = {}) => ok({ message: 'If that number is on file, a code is on its way.', ...extra });
  const customer = await one(env.DB, `SELECT id, ghl_contact_id FROM customers WHERE phone = ?`, phone);
  if (!customer) return generic();

  const recent = await all(
    env.DB,
    `SELECT id FROM auth_tokens WHERE customer_id = ? AND kind = 'sms_otp' AND consumed_at IS NULL AND expires_at > ?`,
    customer.id, nowIso(),
  );
  if (recent.length >= 5) return generic();

  const code = randomDigits(6);
  const tokenHash = await sha256hex(`${code}:${phone}`);
  await run(
    env.DB,
    `INSERT INTO auth_tokens (id, customer_id, kind, token_hash, expires_at, created_ip, created_at)
     VALUES (?, ?, 'sms_otp', ?, ?, ?, ?)`,
    randomToken(12), customer.id, tokenHash, addMinutesIso(10), request.headers.get('cf-connecting-ip') || '', nowIso(),
  );

  await ghlSend(env, {
    customerId: customer.id,
    contactId: customer.ghl_contact_id,
    channel: 'sms',
    template: 'sms_login_code',
    body: `Your Gainz Train login code is ${code}. It expires in 10 minutes.`,
  });

  return generic();
}
