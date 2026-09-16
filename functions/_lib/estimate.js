// nextChargeEstimate: the "about $X" on the customer Home card. Pure, tested in test/next_charge.test.mjs.
//
// It adds the SAME lines the Saturday lock bills (api/admin/lock-week.js): meals at the per-meal rate,
// the delivery line, and the specialty upcharge on this week's picks (SUM(qty * upcharge_per_meal_cents)
// from meal_selections, the column select.js writes at pick time and lock-week.js:117 sums). Then it
// takes off pending meal credits the way credits.js does: meals times the per-meal rate, capped at the
// meal charges, never at delivery. The board caught the first draft leaving the upcharge out (M5): a
// dollar figure on a customer screen is money-touching. It is still an estimate ("about"), because a
// coupon or a proration can move it, so the card says so.
import { creditAmountCents } from './credits.js';

const cents = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };

export function nextChargeEstimate({ mealsPerWeek, perMealCents, deliveryFeeCents = 0, upchargeCents = 0, pendingCreditMeals = 0, discountPct = 0 }) {
  const meals = cents(mealsPerWeek);
  const rate = cents(perMealCents);
  const gross = meals * rate;
  const pct = Math.min(100, Math.max(0, Number(discountPct) || 0));
  const mealsCents = pct > 0 ? Math.round(gross * (1 - pct / 100)) : gross;
  const upcharge = cents(upchargeCents);
  const delivery = cents(deliveryFeeCents);
  // credits.js applyCreditsToDraft: remaining = min(draft.total, perMeal * meals_per_week). The cap is the
  // MEALS line at list rate, never the upcharge and never delivery (QA case 2026-09-16).
  const draftTotal = mealsCents + upcharge + delivery;
  const cap = Math.min(draftTotal, gross);
  const credit = pendingCreditMeals > 0 ? creditAmountCents(pendingCreditMeals, rate, cap) : 0;
  const total = Math.max(0, draftTotal - credit);
  return { amount_cents: total, meals_cents: mealsCents, upcharge_cents: upcharge, delivery_fee_cents: delivery, credit_cents: credit, approx: true };
}
