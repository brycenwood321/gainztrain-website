// GET /api/coupons/validate?code=FOUNDER25 — public, read-only. Lets /start give live feedback on a
// promo code (valid / expired / unknown) instead of failing only at checkout. Returns ONLY public
// (is_public=1) coupons; internal comps like OWNERS100 read as invalid here, same as at checkout.
// This is display-only — checkout/create.js still does the authoritative cap/expiry enforcement.
import { ok, fail } from '../../_lib/respond.js';
import { one } from '../../_lib/db.js';
import { rateLimit, clientIp } from '../../_lib/ratelimit.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const code = (new URL(request.url).searchParams.get('code') || '').trim().toUpperCase().slice(0, 40);
  if (!code) return fail(400, 'code_required', 'Enter a code.');
  if (!(await rateLimit(env, `cval:ip:${clientIp(request)}`, 30, 600))) return ok({ valid: null });
  // FUEL8 flyer promo is special (dynamic tier discount, not a row in the coupons table).
  if (code === 'FUEL8') {
    const ends = Date.parse('2026-09-01T23:59:59-06:00');
    if (!Number.isNaN(ends) && Date.now() > ends) return ok({ valid: false, reason: 'expired' });
    return ok({ valid: true, label: '8 free meals — 2 free every week for 4 weeks!' });
  }
  const c = await one(env.DB, `SELECT is_public, percent_off, expires_at FROM coupons WHERE code = ?`, code);
  if (!c || !c.is_public) return ok({ valid: false, reason: 'invalid' });
  if (c.expires_at && new Date(c.expires_at) < new Date()) return ok({ valid: false, reason: 'expired' });
  return ok({ valid: true, percent_off: c.percent_off ?? null });
}
