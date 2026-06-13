// POST /api/auth/check-email — does an account already exist for this email?
//
// Used by /start to flip Step 3 into a friendly "welcome back, log in" mode on email blur, instead of
// letting a returning customer fill out the whole form and hit a 409 at checkout. Low-sensitivity
// (knowing someone has a Gainz Train account is not a meaningful disclosure) and the register endpoint
// already reveals existence via its 409 — this is the same surface, made friendly. Rate-limited per IP
// so it can't be turned into a bulk-enumeration oracle; on rate-limit it returns exists:null (the caller
// silently falls back to the existing post-Continue 409 handling), never blocking the funnel.
import { ok, fail, readJson } from '../../_lib/respond.js';
import { one } from '../../_lib/db.js';
import { normEmail } from '../../_lib/validate.js';
import { rateLimit, clientIp } from '../../_lib/ratelimit.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await readJson(request);
  const email = normEmail(body.email);
  if (!email || !email.includes('@')) return fail(400, 'invalid_email', 'Enter a valid email address.');
  // Bound it: legit use is 1–3 blur checks per signup. 20 / 10min / IP is plenty for that while making
  // mass enumeration impractical. Don't fail the request on limit — decline to answer so /start degrades.
  if (!(await rateLimit(env, `checkemail:ip:${clientIp(request)}`, 20, 600))) {
    return ok({ exists: null });
  }
  const existing = await one(env.DB, `SELECT id FROM customers WHERE email = ?`, email);
  return ok({ exists: !!existing });
}
