// Shared admin gate for every /api/admin/* endpoint. ONE definition so the check can't drift, and a
// constant-time comparison (hash both sides → equal-length digests → no length/timing oracle on the
// master ops secret). Returns null when authorized, or a 401 Response to return immediately.
import { fail } from './respond.js';
import { sha256hex, constantTimeEqual } from './crypto.js';
import { getSessionCustomer, isStaff, isOwner } from './auth.js';

// Machine/owner path: the shared ADMIN_TOKEN (used by the cron Worker + Brycen's token-gated tools).
export async function requireAdmin(context) {
  const token = context.request.headers.get('x-admin-token') || '';
  const expected = context.env.ADMIN_TOKEN || '';
  if (!expected) return fail(401, 'unauthorized', 'Bad admin token.');
  const [a, b] = await Promise.all([sha256hex(token), sha256hex(expected)]);
  if (!constantTimeEqual(a, b)) return fail(401, 'unauthorized', 'Bad admin token.');
  return null;
}

// Human-OR-machine path for the ops dashboard: a logged-in STAFF account (role='staff') OR the admin
// token. Lets the team (Brycen/Jayson/Marissa/Alyssa) use the backend with their own login while the
// cron keeps using the token. Returns null when authorized, or a 401 Response.
export async function requireStaffOrAdmin(context) {
  const token = context.request.headers.get('x-admin-token') || '';
  if (token) {
    const denied = await requireAdmin(context);
    if (!denied) return null; // valid admin token
  }
  const auth = await getSessionCustomer(context);
  if (auth && isStaff(auth.customer)) return null; // logged-in staff OR owner
  return fail(401, 'unauthorized', 'Staff login or admin token required.');
}

// OWNER-ONLY path: the admin token (machine/superuser) OR a logged-in OWNER (role='owner'). Used to gate
// owner-only data + actions (Overview, Customers, Activity, Marketing, Menu management, staff creation) so
// a logged-in STAFF member gets a hard 403 from the server, not just a hidden nav link.
export async function requireOwner(context) {
  const token = context.request.headers.get('x-admin-token') || '';
  if (token) {
    const denied = await requireAdmin(context);
    if (!denied) return null; // valid admin token
  }
  const auth = await getSessionCustomer(context);
  if (auth && isOwner(auth.customer)) return null; // logged-in owner
  return fail(403, 'forbidden', 'Owner access required.');
}
