// WebCrypto helpers — crypto.subtle + crypto.getRandomValues are global in the Workers runtime.
// Secrets are always stored HASHED, never raw. Comparisons are constant-time.
const enc = new TextEncoder();
const PBKDF2_ITERATIONS = 150000;

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

// 32-byte (default) random token as hex — used for session ids + magic-link secrets.
export function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bufToHex(buf);
}

// A numeric one-time code (SMS OTP). Rejection-sampled to stay uniform over 0-9.
export function randomDigits(n = 6) {
  let out = '';
  while (out.length < n) {
    const buf = new Uint8Array(n);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < 250) out += (b % 10).toString(); // 250 = floor(256/10)*10, avoids modulo bias
      if (out.length === n) break;
    }
  }
  return out;
}

export async function sha256hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return bufToHex(digest);
}

// Constant-time string compare (hex strings of equal length).
export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── Passwords (PBKDF2-SHA256) ────────────────────────────────────────────────
export async function hashPassword(password, saltHex) {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return { hash: bufToHex(bits), salt: bufToHex(salt), iterations: PBKDF2_ITERATIONS };
}

export async function verifyPassword(password, saltHex, expectedHashHex, iterations = PBKDF2_ITERATIONS) {
  const salt = hexToBytes(saltHex);
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return constantTimeEqual(bufToHex(bits), expectedHashHex);
}

// ── HMAC (session cookie integrity) ──────────────────────────────────────────
export async function hmacSign(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return bufToHex(sig);
}

export async function hmacVerify(secret, message, sigHex) {
  const expected = await hmacSign(secret, message);
  return constantTimeEqual(expected, sigHex);
}
