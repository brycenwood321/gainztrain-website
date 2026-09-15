// Sunday pickup details, ONE definition, because these strings appear in several customer messages and
// on five marketing pages, and getting them out of sync is how somebody drives to the wrong place at
// the wrong time.
//
// HISTORY
//   2026-08-23  10:00-10:45, confirmed with Jayson: prep finishes before 10:00, so a tight 45-minute
//               window at the kitchen replaced the informal house pickups. Then the pause wave started
//               three days later; 11 of the 13 paused by 09-13 were pickup customers.
//   D1 in the marketing plan (.claude/plans/gt-marketing-system-2026-09-14.md): widen the window to
//               11:00-1:00 from the 09-20 Sunday as a four-week experiment, $10 miss fee kept. Brycen
//               decides by Thu 2026-09-17. THE SWITCH IS THE SECOND ENTRY BELOW. Adding it, running
//               `node scripts/pickup_window.mjs --render`, `npm test` and pushing is the whole deploy.
//
// The one hard rule: the window must not open before prep reliably ENDS. On 2026-08-09 a customer
// arrived while the team was still prepping; an early window is worse than a late one, because people
// show up to a kitchen that is not ready.
//
// Static marketing copy cannot import this file. Every window mention on a static page is wrapped in a
// <span data-pickup="window|length"> and scripts/pickup_window.mjs rewrites those spans from this list.
// test/pickup_window.test.mjs fails whenever a page disagrees with the list, so a flip cannot half ship.
//
// ⚠️ SMS strings: PLAIN HYPHEN, never an en-dash. Any character outside GSM-7 flips the whole message to
// UCS-2, where a segment is 70 characters instead of 160; one dash was turning a text into two billed
// segments. Same reason there are no emoji or curly quotes in any SMS string.
export const PICKUP_WINDOWS = [
  {
    from: '2026-08-23',           // first Sunday this window applies to (YYYY-MM-DD, a Sunday)
    label: '10:00am–10:45am',     // web and email (en-dash is fine here)
    sms: '10:00am-10:45am',       // GSM-7 only
    minutes: 45,
    lengthLabel: '45-minute',     // "It is a tight 45-minute window"
    lengthSms: '45 min',          // "45 min window"
  },
  // D1, uncomment when Brycen says yes (Thu 2026-09-17), then render + test + push:
  // {
  //   from: '2026-09-20',
  //   label: '11:00am–1:00pm',
  //   sms: '11:00am-1:00pm',
  //   minutes: 120,
  //   lengthLabel: 'two-hour',
  //   lengthSms: '2 hour',
  // },
];

export const PICKUP_ADDRESS = {
  addressLine: '149 N State St, Suite B, Orem',
  addressSms: '149 N State St Ste B, Orem',
};

export const MISS_FEE_DOLLARS = 10;

// The window in force for a given Sunday (YYYY-MM-DD). The latest entry whose `from` is on or before
// that date wins; a date before the first entry gets the first entry.
export function windowFor(sundayISO) {
  let chosen = PICKUP_WINDOWS[0];
  for (const w of PICKUP_WINDOWS) if (w.from <= sundayISO) chosen = w;
  return chosen;
}

// The window that changes ON a given Sunday, or null when that Sunday is not a cutover. Used by the
// pickup_change announcement so it can say what the window was and what it becomes.
export function changeOn(sundayISO) {
  const i = PICKUP_WINDOWS.findIndex((w) => w.from === sundayISO);
  if (i <= 0) return null;
  return { before: PICKUP_WINDOWS[i - 1], after: PICKUP_WINDOWS[i] };
}

// The next Sunday on or after `now` (UTC date arithmetic; the boundary hour does not matter here
// because the window is the same all week and only changes on a Sunday).
export function upcomingSundayISO(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
}

// Full detail block for one Sunday: window plus address plus the ready-made SMS line.
export function pickupFor(sundayISO) {
  const w = windowFor(sundayISO);
  return {
    ...PICKUP_ADDRESS,
    windowLabel: w.label,
    windowSms: w.sms,
    windowMinutes: w.minutes,
    lengthLabel: w.lengthLabel,
    lengthSms: w.lengthSms,
    // Short form for SMS. Hyphens only (see the GSM-7 note above).
    smsLine: `Pickup Sun ${w.sms}, ${PICKUP_ADDRESS.addressSms}. Miss it and delivery is $${MISS_FEE_DOLLARS}.`,
  };
}

// Back-compatible object every existing caller reads (PICKUP.windowLabel, PICKUP.smsLine, ...).
// Getters, not a snapshot: a Worker isolate can live across the Saturday-to-Sunday line, and a value
// captured at module load would keep sending the old window after a cutover.
export const PICKUP = new Proxy({}, {
  get(_t, key) {
    if (key === 'forWeek') return pickupFor;
    return pickupFor(upcomingSundayISO())[key];
  },
  ownKeys() { return Object.keys(pickupFor(upcomingSundayISO())); },
  getOwnPropertyDescriptor(_t, key) {
    return { enumerable: true, configurable: true, value: pickupFor(upcomingSundayISO())[key] };
  },
});

// The sentence used in emails. Kept here so the phrasing stays identical everywhere it appears.
// Pass the delivery Sunday when you have it (order_locked fires on Saturday for the next day, which is
// exactly when a cutover matters); without it the upcoming Sunday is assumed.
export function pickupSentence(sundayISO) {
  const p = sundayISO ? pickupFor(sundayISO) : pickupFor(upcomingSundayISO());
  return `Pick up <b>Sunday between ${p.windowLabel}</b> at <b>${p.addressLine}</b>.`;
}
