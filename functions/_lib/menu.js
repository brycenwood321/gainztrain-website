// Weekly menu helpers. Menus live in data/menus.json (hand-edited) and are published into the
// weekly_menus D1 table (source of truth for the app + ops). week_of is always a Sunday (YYYY-MM-DD).
// Order cutoff is FRIDAY 11:59pm MT before that Sunday (customers get all of Friday; kitchen shops
// Saturday morning, preps Saturday). Changed from Friday MORNING (11:59am) on 2026-07-11 per Brycen.

function iso(d) { return d.toISOString().slice(0, 10); }

// The upcoming Sunday >= today (if today is Sunday, today). Returned as YYYY-MM-DD (UTC date).
export function upcomingSunday(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const add = (7 - d.getUTCDay()) % 7; // days until Sunday (day 0)
  d.setUTCDate(d.getUTCDate() + add);
  return iso(d);
}

// The America/Denver UTC offset (in hours, negative) on a given date — handles MST (-7) / MDT (-6).
function denverOffsetHours(date) {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', timeZoneName: 'shortOffset' })
      .formatToParts(date).find((p) => p.type === 'timeZoneName').value; // e.g. "GMT-6"
    const m = name.match(/GMT([+-]\d+)/);
    return m ? parseInt(m[1], 10) : -7;
  } catch { return -7; }
}

// Order cutoff for a given week: FRIDAY 11:00pm Mountain — the boundary into Saturday.
// Computed as Friday 23:00 America/Denver → UTC, DST-correct (Sat 05:00Z in summer / Sat 06:00Z in winter).
export function cutoffForWeek(weekOfISO) {
  const sunday = new Date(`${weekOfISO}T12:00:00Z`);            // noon avoids date rollover
  const friday = new Date(sunday);
  friday.setUTCDate(friday.getUTCDate() - 2);
  const off = denverOffsetHours(friday);                        // -7 or -6
  // 23:00 local Denver → UTC hour = 23 - offset (MDT -6 → Sat 05:00Z, MST -7 → Sat 06:00Z)
  return new Date(Date.UTC(friday.getUTCFullYear(), friday.getUTCMonth(), friday.getUTCDate(), 23 - off, 0, 0));
}

export function isLocked(weekOfISO, now = new Date()) {
  return now >= cutoffForWeek(weekOfISO);
}

// Weekend ordering blackout: ordering is CLOSED all day Saturday MT (the day after the Friday-11:59pm
// cutoff), reopening Sunday 00:00 MT when the new menu drops / is owner-confirmed. This enforces a clean
// weekly reset even if a future week's menu was confirmed early — customers can't order the new week
// until Sunday. (Was Friday-noon→Sunday; relaxed 2026-07-11 with the cutoff move to Friday 11:59pm MT.)
export function orderingBlackout(now = new Date()) {
  const off = denverOffsetHours(now);                 // -6 (MDT) or -7 (MST)
  const local = new Date(now.getTime() + off * 3600 * 1000);
  return local.getUTCDay() === 6;                     // Denver-local Saturday
}

// Choose the week customers should be ordering for: the upcoming Sunday if it's still before
// cutoff; otherwise it's locked, so move to the following Sunday.
export function orderableWeek(now = new Date()) {
  let wk = upcomingSunday(now);
  if (isLocked(wk, now)) {
    const next = new Date(`${wk}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 7);
    wk = next.toISOString().slice(0, 10);
  }
  return wk;
}
