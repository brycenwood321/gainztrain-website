// Weekly menu helpers. Menus live in data/menus.json (hand-edited) and are published into the
// weekly_menus D1 table (source of truth for the app + ops). week_of is always a Sunday (YYYY-MM-DD).
// Order cutoff is FRIDAY 11:59am before that Sunday (kitchen shops Friday afternoon, preps Saturday).

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

// Order cutoff for a given week: FRIDAY 11:59am Mountain (kitchen shops Friday afternoon, preps Saturday).
// Computed as Friday 11:59 America/Denver → UTC, DST-correct (Fri 17:59Z in summer / 18:59Z in winter).
export function cutoffForWeek(weekOfISO) {
  const sunday = new Date(`${weekOfISO}T12:00:00Z`);            // noon avoids date rollover
  const friday = new Date(sunday);
  friday.setUTCDate(friday.getUTCDate() - 2);
  const off = denverOffsetHours(friday);                        // -7 or -6
  // 11:59 local Denver → UTC hour = 11 - offset (MDT -6 → 17:59Z, MST -7 → 18:59Z)
  return new Date(Date.UTC(friday.getUTCFullYear(), friday.getUTCMonth(), friday.getUTCDate(), 11 - off, 59, 0));
}

export function isLocked(weekOfISO, now = new Date()) {
  return now >= cutoffForWeek(weekOfISO);
}

// Weekend ordering blackout: ordering is CLOSED from Friday 12:00pm MT through Saturday, reopening Sunday
// 00:00 MT (when the new menu drops / is owner-confirmed). This enforces a clean weekly reset even if a
// future week's menu was confirmed early — customers can't order the new week until Sunday. Denver-local,
// DST-correct via denverOffsetHours.
export function orderingBlackout(now = new Date()) {
  const off = denverOffsetHours(now);                 // -6 (MDT) or -7 (MST)
  const local = new Date(now.getTime() + off * 3600 * 1000);
  const day = local.getUTCDay();                      // Denver-local 0 Sun .. 6 Sat
  const hour = local.getUTCHours();
  if (day === 5 && hour >= 12) return true;           // Friday 12:00pm MT onward
  if (day === 6) return true;                         // all day Saturday
  return false;
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
