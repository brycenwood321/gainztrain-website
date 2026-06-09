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
  return ok({ prefs: row || DEFAULTS });
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
  return ok({ prefs: v });
}
