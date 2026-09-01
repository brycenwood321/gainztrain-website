// GET /api/plans is the public plan list for the pick-a-plan page (no Stripe ids leaked).
// With SIZES_ENABLED (Build 3) the response ALSO carries sizes_enabled + the size table; with the
// flag off the payload is exactly what it always was, so the existing /start UI is untouched.
import { ok } from '../_lib/respond.js';
import { publicPlans, publicSizes, sizesEnabled, MIN_MEALS, MAX_MEALS } from '../_lib/plans.js';

export async function onRequestGet(context) {
  const base = { plans: publicPlans(), min_meals: MIN_MEALS, max_meals: MAX_MEALS };
  if (sizesEnabled(context && context.env)) {
    return ok({ ...base, sizes_enabled: true, sizes: publicSizes() });
  }
  return ok(base);
}
