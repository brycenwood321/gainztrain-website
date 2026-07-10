// POST /api/auth/register — create a customer account (password optional; they can use magic-link).
import { ok, fail, readJson } from '../../_lib/respond.js';
import { one, run, nowIso } from '../../_lib/db.js';
import { randomToken, hashPassword } from '../../_lib/crypto.js';
import { createSession } from '../../_lib/auth.js';
import { notify } from '../../_lib/notify.js';
import { str, normEmail, toE164 } from '../../_lib/validate.js';
import { rateLimit, clientIp } from '../../_lib/ratelimit.js';
import { capiEvent } from '../../_lib/capi.js';

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
  if (!(await rateLimit(env, `register:ip:${clientIp(request)}`, 6, 3600))) return fail(429, 'rate_limited', 'Too many signups from your network. Please try again later.');
  if (password && password.length < 8) return fail(400, 'weak_password', 'Password must be at least 8 characters.');
  // Normalize phone to E.164 so it matches the OTP-login lookup; reject garbage rather than store it.
  const phone = phoneRaw ? toE164(phoneRaw) : '';
  if (phoneRaw && !phone) return fail(400, 'invalid_phone', 'Enter a valid phone number.');

  const existing = await one(env.DB, `SELECT id FROM customers WHERE email = ?`, email);
  if (existing) return fail(409, 'email_exists', 'An account with that email already exists — try logging in.');

  const id = randomToken(16);
  const now = nowIso();
  // Express written consent for promotional SMS: the UNCHECKED checkbox on /start (A2P/TCPA proof).
  // Only meaningful with a real phone; stored with a timestamp so every marketing send is defensible.
  const smsOptIn = body.sms_opt_in === true && !!phone;
  try {
    await run(
      env.DB,
      `INSERT INTO customers (id, email, first_name, last_name, phone, role, sms_marketing_consent, sms_consent_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'customer', ?, ?, ?, ?)`,
      id, email, firstName, lastName, phone || null, smsOptIn ? 1 : 0, smsOptIn ? now : null, now, now,
    );
  } catch {
    // UNIQUE(email) race: another request registered the same email between our check + insert.
    return fail(409, 'email_exists', 'An account with that email already exists — try logging in.');
  }

  // Marketing attribution (Phase 1): first-touch UTMs captured client-side + the self-reported
  // "how did you hear about us?" answer. Best-effort — attribution must never fail a signup.
  try {
    const attr = (body.attribution && typeof body.attribution === 'object') ? body.attribution : {};
    const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null) || null;
    const selfReported = clip(str(body.heard_about).trim().toLowerCase(), 40);
    const hasUtm = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid', 'referrer']
      .some((k) => typeof attr[k] === 'string' && attr[k]);
    if (selfReported || hasUtm) {
      await run(
        env.DB,
        `INSERT INTO attribution (customer_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
           gclid, fbclid, landing_path, referrer, self_reported, self_reported_detail, first_touch_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, clip(attr.utm_source, 120), clip(attr.utm_medium, 120), clip(attr.utm_campaign, 120),
        clip(attr.utm_content, 120), clip(attr.utm_term, 120), clip(attr.gclid, 120), clip(attr.fbclid, 120),
        clip(attr.landing_path, 300), clip(attr.referrer, 300),
        selfReported, clip(str(body.heard_detail).trim(), 200), clip(attr.first_touch_at, 40), now,
      );
    }
  } catch { /* non-fatal */ }

  try {
    if (password) {
      const { hash, salt, iterations } = await hashPassword(password);
      await run(
        env.DB,
        `INSERT INTO auth_passwords (customer_id, password_hash, salt, iterations, updated_at) VALUES (?, ?, ?, ?, ?)`,
        id, hash, salt, iterations, now,
      );
    }
    // Meta CAPI Lead event (env-gated no-op until the pixel exists). event_id = lead_<customer id>
    // so a future browser pixel firing the same event dedups instead of double-counting.
    await capiEvent(env, 'Lead', { email, phone, event_id: `lead_${id}` });

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
