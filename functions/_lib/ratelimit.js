// Fixed-window rate limiter backed by D1 (no KV/Durable Object binding on this project). Defense in
// depth on the auth surface. FAILS OPEN on any limiter error — a limiter bug must never lock real users
// out of their account; the limiter is a safety net, not the primary control.
import { one, run } from './db.js';

// Returns true if ALLOWED, false if the bucket is over `max` within `windowSeconds`.
export async function rateLimit(env, bucket, max, windowSeconds) {
  try {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const row = await one(env.DB, `SELECT count, window_start FROM rate_limits WHERE bucket = ?`, bucket);
    if (!row) {
      await run(env.DB,
        `INSERT INTO rate_limits (bucket, count, window_start) VALUES (?, 1, ?)
         ON CONFLICT(bucket) DO UPDATE SET count = count + 1`,
        bucket, nowIso);
      return true;
    }
    const elapsed = (nowMs - new Date(row.window_start).getTime()) / 1000;
    if (elapsed > windowSeconds) {
      await run(env.DB, `UPDATE rate_limits SET count = 1, window_start = ? WHERE bucket = ?`, nowIso, bucket);
      return true;
    }
    if (row.count >= max) return false;
    await run(env.DB, `UPDATE rate_limits SET count = count + 1 WHERE bucket = ?`, bucket);
    return true;
  } catch {
    return true; // fail open
  }
}

// The client IP behind Cloudflare.
export function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
}
