// GET /api/plans — public plan list for the pick-a-plan page (no Stripe ids leaked).
import { ok } from '../_lib/respond.js';
import { publicPlans, MIN_MEALS, MAX_MEALS } from '../_lib/plans.js';

export async function onRequestGet() {
  return ok({ plans: publicPlans(), min_meals: MIN_MEALS, max_meals: MAX_MEALS });
}
