// Shared admin gate for every /api/admin/* endpoint. ONE definition so the check can't drift, and a
// constant-time comparison (hash both sides → equal-length digests → no length/timing oracle on the
// master ops secret). Returns null when authorized, or a 401 Response to return immediately.
import { fail } from './respond.js';
import { sha256hex, constantTimeEqual } from './crypto.js';

export async function requireAdmin(context) {
  const token = context.request.headers.get('x-admin-token') || '';
  const expected = context.env.ADMIN_TOKEN || '';
  if (!expected) return fail(401, 'unauthorized', 'Bad admin token.');
  const [a, b] = await Promise.all([sha256hex(token), sha256hex(expected)]);
  if (!constantTimeEqual(a, b)) return fail(401, 'unauthorized', 'Bad admin token.');
  return null;
}
