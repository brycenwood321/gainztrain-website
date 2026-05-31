// Shared input coercion + normalization. ONE definition so the write path (register) and the
// read path (login / OTP lookup) can never diverge, and non-string JSON values can't crash a
// handler with a 500 that leaks a stack trace.

// Always return a string — a non-string (object/array/number/null) becomes ''.
export function str(v) {
  return typeof v === 'string' ? v : '';
}

export function normEmail(v) {
  return str(v).trim().toLowerCase();
}

// Normalize to strict E.164 (+<country><number>). Returns '' if it can't form a VALID number,
// so callers can reject garbage instead of storing an unusable "+" string.
export function toE164(v) {
  const raw = str(v).trim();
  const digits = raw.replace(/[^0-9]/g, '');
  let e;
  if (raw.startsWith('+')) e = '+' + digits;
  else if (digits.length === 10) e = '+1' + digits;        // US 10-digit
  else if (digits.length === 11 && digits.startsWith('1')) e = '+' + digits;
  else e = '+' + digits;
  return /^\+[1-9]\d{7,14}$/.test(e) ? e : '';
}
