// POST /api/auth/logout — revoke the current session and clear the cookie.
import { ok } from '../../_lib/respond.js';
import { getSessionCustomer, revokeSession, clearSessionCookie } from '../../_lib/auth.js';

export async function onRequestPost(context) {
  const auth = await getSessionCustomer(context);
  if (auth) await revokeSession(context.env, auth.session.id);
  return ok({}, { 'Set-Cookie': clearSessionCookie() });
}
