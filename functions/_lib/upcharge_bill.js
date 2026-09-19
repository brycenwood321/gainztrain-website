// MISSED-UPCHARGE BILLING, the pure half. Used by api/admin/bill-missed-upcharges.js (I/O) and tested in
// test/missed_upcharge.test.mjs.
//
// 2026-09-19: the 08:00 lock pass stalled at 14 of 32, Stripe finalized and charged the other 17 weekly
// invoices on its own at 08:15, and the lock then read them as SETTLED. A finalized invoice cannot take
// a new line, so the specialty upcharge on those weeks was logged (audit_log upcharge_missed_settled)
// and never billed: 18 rows, $174.50, two of them comps. Brycen's call the same morning: bill it today
// as its own invoice, and make that invoice say exactly which meals it is for.

// One line per specialty meal the customer actually had locked that week. `selections` are
// meal_selections rows: { meal_position, meal_name, qty, upcharge_per_meal_cents }.
export function upchargeLines(selections) {
  const lines = [];
  for (const s of selections || []) {
    const qty = Number(s.qty) || 0, per = Number(s.upcharge_per_meal_cents) || 0;
    if (qty <= 0 || per <= 0) continue;
    lines.push({
      position: s.meal_position, name: s.meal_name, qty, perMealCents: per, cents: qty * per,
      description: `${qty}x ${s.meal_name}, specialty upcharge $${(per / 100).toFixed(2)} per meal`,
    });
  }
  return lines;
}

export function upchargeTotal(lines) {
  return (lines || []).reduce((a, l) => a + l.cents, 0);
}

// The memo printed on the Stripe invoice and the receipt. Says what it is, why it exists, and that it
// is ONLY the upcharge, in the customer's words not ours.
export function upchargeMemo(weekOf) {
  const d = new Date(`${weekOf}T12:00:00Z`);
  const when = Number.isNaN(d.getTime()) ? weekOf : d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `Specialty meal upcharge for your ${when} delivery. Your weekly charge this morning covered your meals, `
    + `but the specialty upcharge on the meals listed below was left off it by mistake on our side. `
    + `This invoice is only that upcharge. Nothing else about your order changes.`;
}

// Decide what to do with one customer's missed row. Pure, so the branches are testable.
//   audited     : the upcharge_missed_settled row's cents
//   order       : the orders row for that week (charge_status), or null
//   alreadyRow  : an existing missed_upcharge_billed audit row, or null
//   lines       : upchargeLines(selections)
export function missedUpchargePlan({ audited, order, alreadyRow, lines }) {
  if (alreadyRow) return { bill: false, reason: 'already_billed' };
  if (!order || order.status !== 'locked') return { bill: false, reason: 'no_locked_order' };
  if (order.charge_status === 'comp') return { bill: false, reason: 'comp' };
  const total = upchargeTotal(lines);
  if (total <= 0) return { bill: false, reason: 'no_specialty_meals' };
  // The selections are what was cooked; the audit row is what the lock computed at the time. They
  // should agree. If they do not, bill what was cooked and say so, never the larger of the two.
  return { bill: true, cents: total, mismatch: total !== audited ? { audited, fromSelections: total } : null };
}
