// Pause / cancel reasons: ONE list, read by the two account endpoints and mirrored by the picker in
// app/manage/index.html (a static page cannot import this; test/reasons.test.mjs fails if they drift).
//
// PROVISIONAL (2026-09-14): written from the plan's hypotheses, not from data. The 13 paused customers
// were asked why on 09-14 and the list is to be re-cut from their replies (plan rev 4, 09-28 row).
// "Pickup time" is its own tap on purpose: it is the reason the plan bets on, so it must never be
// buried inside "schedule" or "other" where nobody can count it.
export const REASONS = [
  { code: 'pickup_time',   label: 'The Sunday pickup time' },
  { code: 'too_much_food', label: 'Too much food' },
  { code: 'price',         label: 'Price' },
  { code: 'menu',          label: 'The menu' },
  { code: 'delivery',      label: 'Delivery' },
  { code: 'break',         label: 'Taking a break (travel, schedule)' },
  { code: 'other',         label: 'Something else' },
];

// Tapped through without picking. Stored, not null, so "asked and declined" is distinct from
// "never asked" (every row written before 0029).
export const DECLINED = 'declined';

export const REASON_TEXT_MAX = 280;

export function reasonLabel(code) {
  if (code === DECLINED) return 'declined to say';
  const r = REASONS.find((x) => x.code === code);
  return r ? r.label : (code || '');
}

// Normalise a request body into { code, text }. Unknown codes become 'other' with the raw code kept in
// the text, so a client drift never loses what the customer meant. Never throws.
export function readReason(body) {
  const raw = body && typeof body === 'object' ? body : {};
  let code = typeof raw.reason === 'string' ? raw.reason.trim().toLowerCase() : '';
  let text = typeof raw.reason_text === 'string' ? raw.reason_text.trim().slice(0, REASON_TEXT_MAX) : '';
  if (!code) code = DECLINED;
  else if (code !== DECLINED && !REASONS.some((r) => r.code === code)) {
    text = text ? `${code}: ${text}` : code;
    code = 'other';
  }
  return { code, text: text || null };
}
