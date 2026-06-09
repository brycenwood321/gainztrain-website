// GET /api/notifications — the logged-in customer's in-app notification feed (most recent first) plus
// the unread count for the bell badge. Session-gated.
import { ok, fail } from '../_lib/respond.js';
import { all, one } from '../_lib/db.js';
import { getSessionCustomer } from '../_lib/auth.js';

export async function onRequestGet(context) {
  const auth = await getSessionCustomer(context);
  if (!auth) return fail(401, 'not_authenticated', 'Please log in.');
  const { env } = context;

  const rows = await all(env.DB,
    `SELECT id, event_key, title, body, href, category, read_at, created_at
       FROM notifications WHERE customer_id = ? ORDER BY created_at DESC LIMIT 30`,
    auth.customer.id);
  const u = await one(env.DB,
    `SELECT COUNT(*) AS n FROM notifications WHERE customer_id = ? AND read_at IS NULL`,
    auth.customer.id);
  return ok({ notifications: rows, unread: u?.n || 0 });
}
