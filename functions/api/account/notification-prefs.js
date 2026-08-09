// GET/POST /api/account/notification-prefs — read or update the customer's opt-outs. Only the four
// controllable flags exist; transactional/security notifications always send and aren't represented.
// Session-gated. No prefs row = the defaults below.
import { ok, fail, readJson } from '../../_lib/respond.js';
import { one, run, nowIso } from '../../_lib/db.js';
import { getSessionCustomer } from '../../_lib/auth.js';

const DEFAULTS = { email_account: 1, email_marketing: 1, sms_account: 1, sms_marketing: 0 };
const FIELDS = ['email_account', 'email_marketing', 'sms_account', 'sms_marketing'];

export async function onRequestGet(context) {
  const auth = await getSessionCustomer(context);
  if (!auth) return fail(401, 'not_authenticated', 'Please log in.');
  const row = await one(context.env.DB,
    `SELECT email_account, email_marketing, sms_account, sms_marketing FROM notification_prefs WHERE customer_id = ?`,
    auth.customer.id);
  // SMS consent lives on customers (not here) because it's A2P/TCPA evidence, not a preference —
  // it needs its own timestamp and it's the flag notify() checks before any text. Surfaced alongside
  // the prefs so /app/manage can render one coherent "how we reach you" section.
  const c = await one(context.env.DB,
    `SELECT phone, sms_marketing_consent, sms_consent_at FROM customers WHERE id = ?`, auth.customer.id);
  return ok({
    prefs: row || DEFAULTS,
    sms_consent: !!(c && Number(c.sms_marketing_consent) === 1),
    sms_consent_at: (c && c.sms_consent_at) || null,
    has_phone: !!(c && c.phone),
  });
}

export async function onRequestPost(context) {
  const auth = await getSessionCustomer(context);
  if (!auth) return fail(401, 'not_authenticated', 'Please log in.');
  const raw = await readJson(context.request);
  const body = (raw && typeof raw === 'object') ? raw : {}; // null/number/string body → treat as empty
  const truthy = (x) => (x === true || x === 1 || x === '1') ? 1 : 0;

  // Merge over current values so a partial POST only changes what it sends.
  const cur = await one(context.env.DB,
    `SELECT email_account, email_marketing, sms_account, sms_marketing FROM notification_prefs WHERE customer_id = ?`,
    auth.customer.id) || DEFAULTS;
  const v = {};
  for (const f of FIELDS) v[f] = (f in body) ? truthy(body[f]) : cur[f];

  await run(context.env.DB,
    `INSERT INTO notification_prefs (customer_id, email_account, email_marketing, sms_account, sms_marketing, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(customer_id) DO UPDATE SET email_account=excluded.email_account, email_marketing=excluded.email_marketing,
       sms_account=excluded.sms_account, sms_marketing=excluded.sms_marketing, updated_at=excluded.updated_at`,
    auth.customer.id, v.email_account, v.email_marketing, v.sms_account, v.sms_marketing, nowIso());

  // SMS consent (A2P/TCPA). Only written when the field is actually present, so a partial prefs POST
  // can never clear someone's consent as a side effect. Turning it ON stamps a fresh timestamp — that
  // timestamp plus the disclosure shown next to the toggle is the evidence trail for the carrier.
  // Turning it OFF keeps the old timestamp as a record of when consent had been given.
  let smsConsent = null;
  if ('sms_consent' in body) {
    smsConsent = truthy(body.sms_consent);
    const cur = await one(context.env.DB, `SELECT phone, sms_marketing_consent FROM customers WHERE id = ?`, auth.customer.id);
    // Consent without a number to text is meaningless — make the caller add a phone first rather than
    // recording a consent we could never act on.
    if (smsConsent === 1 && !(cur && cur.phone)) {
      return fail(400, 'phone_required', 'Add your phone number before turning on text updates.');
    }
    if (smsConsent === 1) {
      await run(context.env.DB,
        `UPDATE customers SET sms_marketing_consent = 1, sms_consent_at = ?, updated_at = ? WHERE id = ?`,
        nowIso(), nowIso(), auth.customer.id);
    } else {
      await run(context.env.DB,
        `UPDATE customers SET sms_marketing_consent = 0, updated_at = ? WHERE id = ?`,
        nowIso(), auth.customer.id);
    }
  }
  return ok({ prefs: v, sms_consent: smsConsent === null ? undefined : !!smsConsent });
}
