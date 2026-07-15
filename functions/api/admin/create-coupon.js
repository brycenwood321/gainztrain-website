// POST /api/admin/create-coupon — mint a promo code in BOTH places it has to live: a live Stripe
// coupon (whose id == the code, because checkout applies `discounts:[{coupon: code}]`) AND a row in
// the D1 `coupons` table (the gate that controls is_public visibility + cap + expiry on /start and at
// checkout). Admin-token only. Idempotent: re-running with the same code updates the D1 row and reuses
// the existing Stripe coupon instead of erroring.
//
//   Body {
//     code,                       // e.g. "GAINZ50" — uppercased, becomes the Stripe coupon id
//     percent_off,                // integer 1..100
//     duration = 'once',          // 'once' = first order only | 'forever' | 'repeating'
//     cap,                        // optional integer — max total redemptions (Stripe max_redemptions)
//     expires_at,                 // optional ISO-8601 — Stripe redeem_by + our display/checkout gate
//     is_public = true            // 1 = shows as valid on /start; 0 = silent comp (e.g. OWNERS100)
//   }
import { ok, fail, readJson } from '../../_lib/respond.js';
import { requireOwner } from '../../_lib/admin.js';
import { one, run, nowIso } from '../../_lib/db.js';
import { stripe } from '../../_lib/stripe.js';

export async function onRequestPost(context) {
  const { env } = context;
  const denied = await requireOwner(context); // owners can mint promo codes from the /ops Settings tab
  if (denied) return denied;

  const body = await readJson(context.request);
  const code = String(body.code || '').trim().toUpperCase().slice(0, 40);
  if (!/^[A-Z0-9]{3,40}$/.test(code)) return fail(400, 'invalid_code', 'Code must be 3-40 letters/digits.');

  const percent = Math.round(Number(body.percent_off));
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) return fail(400, 'invalid_percent', 'percent_off must be 1-100.');

  const duration = ['once', 'forever', 'repeating'].includes(body.duration) ? body.duration : 'once';
  const cap = body.cap != null && Number.isInteger(Number(body.cap)) && Number(body.cap) > 0 ? Number(body.cap) : null;
  const isPublic = body.is_public === false ? 0 : 1;

  let expiresAt = null, redeemBy = null;
  if (body.expires_at) {
    const t = Date.parse(body.expires_at);
    if (Number.isNaN(t)) return fail(400, 'invalid_expiry', 'expires_at must be ISO-8601.');
    expiresAt = new Date(t).toISOString();
    redeemBy = Math.floor(t / 1000); // Stripe wants Unix seconds
  }

  // 1) Stripe coupon — id == code so checkout can apply it directly. Reuse if it already exists.
  let stripeId = code, reused = false;
  try {
    const params = { id: code, name: code, percent_off: percent, duration };
    if (cap) params.max_redemptions = cap;
    if (redeemBy) params.redeem_by = redeemBy;
    const sc = await stripe(env, 'POST', 'coupons', params);
    stripeId = sc.id;
  } catch (e) {
    // Stripe rejects a duplicate id with resource_already_exists — that's fine, mint the D1 row anyway.
    if (e?.stripe?.code === 'resource_already_exists') {
      reused = true;
    } else {
      return fail(502, 'stripe_failed', `Stripe: ${e.message}`);
    }
  }

  // 2) D1 row — upsert so a re-run refreshes terms without resetting the redemption counter.
  const now = nowIso();
  await run(env.DB,
    `INSERT INTO coupons (code, stripe_coupon_id, percent_off, duration, cap, expires_at, is_public, times_redeemed)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(code) DO UPDATE SET
       stripe_coupon_id=excluded.stripe_coupon_id, percent_off=excluded.percent_off,
       duration=excluded.duration, cap=excluded.cap, expires_at=excluded.expires_at,
       is_public=excluded.is_public`,
    code, stripeId, percent, duration, cap, expiresAt, isPublic);

  try {
    await run(env.DB, `INSERT INTO audit_log (at, actor, entity, action, detail_json) VALUES (?, 'admin', ?, 'create_coupon', ?)`,
      now, `coupon:${code}`, JSON.stringify({ code, percent, duration, cap, expiresAt, isPublic, reused }));
  } catch { /* non-fatal */ }

  return ok({ code, percent_off: percent, duration, cap, expires_at: expiresAt, is_public: isPublic, stripe_coupon_reused: reused });
}
