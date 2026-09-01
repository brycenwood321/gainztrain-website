// Self-test for the sizes pricing core (Build 3). Run: node scripts/test_sizes.mjs
//
// The expected cells are HARDCODED from plan Part 4b, the table Brycen decided, not recomputed
// through the same formula the code uses. Two sides of a check must not share a source
// (memory: two-sides-of-a-check-same-source).
import { TIERS, SIZES, sizePriceTable, perMealCentsFor, sizeForCustomer, MIN_MEALS, MAX_MEALS } from '../functions/_lib/plans.js';

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failures++; console.error(`FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${label}`);
};

// 1. The 12 cells, verbatim from plan Part 4b (cents).
const DECIDED = {
  mini:    [925, 837, 749],
  regular: [1050, 950, 850],
  large:   [1175, 1063, 951],
  custom:  [1600, 1448, 1295],
};
for (const row of sizePriceTable()) {
  check(`4b row ${row.key}`, row.bands.map((b) => b.per_meal_cents), DECIDED[row.key]);
}

// 2. Flag OFF: every size, every meal count 6..16 returns the legacy TIERS price exactly.
const envOff = {};
for (let meals = MIN_MEALS; meals <= MAX_MEALS; meals++) {
  const legacy = TIERS.find((t) => meals >= t.min && meals <= t.max).perMealCents;
  for (const s of SIZES) {
    const got = perMealCentsFor(envOff, s.key, meals);
    if (got !== legacy) { failures++; console.error(`FAIL flag-off ${s.key}@${meals}: ${got} != ${legacy}`); }
  }
}
console.log('ok   flag OFF == legacy for all sizes x 6..16 meals');

// 3. Flag ON: 'regular' (and a missing/unknown size) still returns the legacy price exactly,
// so flipping the flag changes nobody's bill.
const envOn = { SIZES_ENABLED: 'true' };
for (let meals = MIN_MEALS; meals <= MAX_MEALS; meals++) {
  const legacy = TIERS.find((t) => meals >= t.min && meals <= t.max).perMealCents;
  for (const key of ['regular', null, undefined, 'standard', 'garbage']) {
    const got = perMealCentsFor(envOn, key, meals);
    if (got !== legacy) { failures++; console.error(`FAIL flag-on default ${key}@${meals}: ${got} != ${legacy}`); }
  }
}
console.log('ok   flag ON default/regular/unknown == legacy for all 6..16 meals');

// 4. sizeForCustomer never reads portion_size: a signup-Large customer stays regular-priced
// until an explicit size_key is set.
check('portion_size large stays regular', sizeForCustomer({ portion_size: 'large' }).key, 'regular');
check('size_key large resolves large', sizeForCustomer({ size_key: 'large' }).key, 'large');
check('no customer resolves regular', sizeForCustomer(null).key, 'regular');

// 5. Out-of-band meal counts refuse a price rather than inventing one.
check('out of band returns null', perMealCentsFor(envOn, 'large', 40), null);

if (failures) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log('\nall sizes pricing checks pass');
