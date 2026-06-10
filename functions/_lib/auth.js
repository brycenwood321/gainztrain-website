// Session + role helpers. Sessions are opaque 256-bit ids stored in D1 (revocable);
// the cookie carries id + HMAC so forged/garbage cookies are rejected without a DB hit.
import { one, run, nowIso, addDaysIso } from './db.js';
import { randomToken, hmacSign, hmacVerify } from './crypto.js';

const SESSION_COOKIE = 'gt_session';
const SESSION_TTL_DAYS = 30;

function buildCookie(name, value, maxAgeSeconds) {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

// Fail closed if the cookie-signing secret is missing/weak. Without this guard a misconfigured deploy
// would sign cookies with an empty key (publicly forgeable) instead of refusing to issue sessions.
function requireHmacSecret(env) {
  const s = env.SESSION_HMAC_SECRET;
  if (!s || typeof s !== 'string' || s.length < 16) {
    throw new Error('SESSION_HMAC_SECRET is missing or too short — refusing to sign sessions.');
  }
}

export async function createSession(env, customerId, request) {
  requireHmacSecret(env);
  const id = randomToken(32);
  const now = nowIso();
  await run(
    env.DB,
    `INSERT INTO sessions (id, customer_id, created_at, last_seen_at, expires_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    customerId,
    now,
    now,
    addDaysIso(SESSION_TTL_DAYS),
    request.headers.get('user-agent') || '',
    request.headers.get('cf-connecting-ip') || '',
  );
  const sig = await hmacSign(env.SESSION_HMAC_SECRET, id);
  const cookie = buildCookie(SESSION_COOKIE, `${id}.${sig}`, SESSION_TTL_DAYS * 86400);
  return { id, cookie };
}

function parseCookies(request) {
  const header = request.headers.get('cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Resolve the logged-in customer from cookie OR Bearer token (Bearer reserved for future
// native app). Returns { session, customer } or null. Never throws.
export async function getSessionCustomer(context) {
  const { request, env } = context;
  let value = parseCookies(request)[SESSION_COOKIE];
  if (!value) {
    const authHeader = request.headers.get('authorization') || '';
    if (authHeader.startsWith('Bearer ')) value = authHeader.slice(7).trim();
  }
  if (!value || !value.includes('.')) return null;

  const dot = value.lastIndexOf('.');
  const id = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!id || !sig) return null;
  // Missing/weak secret → no session is valid (rather than verifying against a forgeable empty key).
  if (!env.SESSION_HMAC_SECRET || env.SESSION_HMAC_SECRET.length < 16) return null;
  if (!(await hmacVerify(env.SESSION_HMAC_SECRET, id, sig))) return null;

  const session = await one(env.DB, `SELECT * FROM sessions WHERE id = ?`, id);
  if (!session || session.revoked_at) return null;
  if (session.expires_at < nowIso()) return null;

  const customer = await one(env.DB, `SELECT * FROM customers WHERE id = ?`, session.customer_id);
  if (!customer) return null;

  // Sliding expiry: bump if last seen > 1 day ago (best-effort).
  if (session.last_seen_at < addDaysIso(-1)) {
    try {
      await run(env.DB, `UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?`,
        nowIso(), addDaysIso(SESSION_TTL_DAYS), id);
    } catch { /* non-fatal */ }
  }
  return { session, customer };
}

export function isStaff(customer) {
  return !!customer && customer.role === 'staff';
}

export async function revokeSession(env, sessionId) {
  await run(env.DB, `UPDATE sessions SET revoked_at = ? WHERE id = ?`, nowIso(), sessionId);
}

export function clearSessionCookie() {
  return buildCookie(SESSION_COOKIE, '', 0);
}
