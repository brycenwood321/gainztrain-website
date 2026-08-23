// Sunday pickup details — ONE definition, because these two strings appear in several customer
// messages and getting them out of sync is how somebody drives to the wrong place at the wrong time.
//
// WINDOW CONFIRMED 2026-08-22 with Jayson: prep now finishes before 10:00, so pickup is a tight
// 45-minute window (10:00-10:45) at the kitchen. This replaced an informal stretch where people were
// collecting from Brycen's or Jayson's house. Whatever it becomes, change it HERE and every message
// follows. The one hard rule: the window must not open before prep reliably ENDS. On 2026-08-09 a
// customer arrived while the team was still prepping, which is the failure this is meant to prevent —
// an early window is worse than a late one, because people show up to a kitchen that isn't ready.
//
// Static marketing copy can't import this file. If the window changes, also update:
//   how-it-works/, faqs/, delivery/, index.html  (grep for "11:00" and "State St")
export const PICKUP = {
  addressLine: '149 N State St, Suite B, Orem',
  windowLabel: '10:00am–10:45am',
  // Short form for SMS. ⚠️ PLAIN HYPHEN, never an en-dash. Any character outside GSM-7 flips the whole
  // message to UCS-2, where a segment is 70 characters instead of 160 — one dash was turning this text
  // into two billed segments. Same reason there are no emoji or curly quotes in any SMS string.
  smsLine: 'Pickup Sun 10:00am-10:45am, 149 N State St Ste B, Orem. Miss it and delivery is $10.',
};

// The sentence used in emails. Kept here so the phrasing stays identical everywhere it appears.
export function pickupSentence() {
  return `Pick up <b>Sunday between ${PICKUP.windowLabel}</b> at <b>${PICKUP.addressLine}</b>.`;
}
