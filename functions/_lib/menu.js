// Weekly menu helpers. Menus live in data/menus.json (hand-edited) and are published into the
// weekly_menus D1 table (source of truth for the app + ops). week_of is always a Sunday (YYYY-MM-DD).
// Order cutoff is FRIDAY night before that Sunday (groceries are bought Saturday).

function iso(d) { return d.toISOString().slice(0, 10); }

// The upcoming Sunday >= today (if today is Sunday, today). Returned as YYYY-MM-DD (UTC date).
export function upcomingSunday(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const add = (7 - d.getUTCDay()) % 7; // days until Sunday (day 0)
  d.setUTCDate(d.getUTCDate() + add);
  return iso(d);
}

// Order cutoff for a given week: the Friday night before the Sunday week_of.
// We use Saturday 06:00 UTC ≈ Friday ~11pm Mountain as the lock moment.
export function cutoffForWeek(weekOfISO) {
  const sunday = new Date(`${weekOfISO}T00:00:00Z`);
  const cutoff = new Date(sunday);
  cutoff.setUTCDate(cutoff.getUTCDate() - 1); // Saturday 00:00Z
  cutoff.setUTCHours(6, 0, 0, 0);             // ~Fri 11pm Mountain
  return cutoff;
}

export function isLocked(weekOfISO, now = new Date()) {
  return now >= cutoffForWeek(weekOfISO);
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
