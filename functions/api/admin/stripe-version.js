// GET /api/admin/stripe-version
//
// What API version is Stripe ACTUALLY running this account on? stripe.js sends no Stripe-Version
// header until STRIPE_API_VERSION is set, so the answer lives on Stripe's side, readable from the
// api_version stamped on recent events. Built 2026-08-31 to pin the version with the account's real
// current value instead of a guess (the lib's own warning: guessing a version changes live billing
// behaviour the moment it deploys).
//
// Also reports whether the pin is set and whether it matches, so this doubles as the check that the
// pin never drifts from what the account expects.
import { json } from '../../_lib/respond.js';
import { requireAdmin } from '../../_lib/admin.js';
import { stripe } from '../../_lib/stripe.js';

export async function onRequestGet(context) {
  const denied = await requireAdmin(context); if (denied) return denied;
  const { env } = context;
  try {
    const events = await stripe(env, 'GET', 'events', { limit: 5 });
    const versions = [...new Set((events?.data || []).map((e) => e.api_version).filter(Boolean))];
    const pinned = env.STRIPE_API_VERSION || null;
    return json({
      ok: true,
      account_event_versions: versions,
      pinned,
      status: !pinned
        ? 'UNPINNED: every call runs on the account default, which Stripe can move silently'
        : versions.length && !versions.includes(pinned)
          ? 'MISMATCH: pinned version differs from what the account is stamping on events'
          : 'pinned',
    }, 200);
  } catch (e) {
    return json({ ok: false, error: String(e && e.message).slice(0, 200) }, 502);
  }
}
