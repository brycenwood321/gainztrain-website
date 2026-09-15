// GET /api/account/referral — the logged-in customer's referral code, link, share text and status.
// Mints the code on first call. The credit lands at the next lock, never as cash.
import { ok, fail } from '../../_lib/respond.js';
import { getSessionCustomer } from '../../_lib/auth.js';
import { one } from '../../_lib/db.js';
import { referralSummary } from '../../_lib/referral.js';

export async function onRequestGet(context) {
  const auth = await getSessionCustomer(context);
  if (!auth) return fail(401, 'not_authenticated', 'Please log in.');
  const customer = await one(context.env.DB, `SELECT id, first_name, referral_code FROM customers WHERE id = ?`, auth.customer.id);
  if (!customer) return fail(404, 'not_found', 'No such customer.');
  return ok(await referralSummary(context.env, customer));
}
