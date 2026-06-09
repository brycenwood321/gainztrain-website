// GET /api/unsubscribe?c=<customer>&t=<hmac> — one-click CAN-SPAM unsubscribe from MARKETING email
// (menu drops + reminders). No login required: the signature (HMAC of "unsub:<id>" with the session
// secret) authorizes it. Transactional/security email is never affected.
import { one, run, nowIso } from '../_lib/db.js';
import { hmacVerify } from '../_lib/crypto.js';

function page(msg, status = 200) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<body style="font-family:system-ui,-apple-system,sans-serif;max-width:30rem;margin:4rem auto;padding:0 1rem;text-align:center;color:#1a1614">` +
    `<div style="font-weight:800;font-size:1.4rem">GAINZ<span style="color:#ff6b35">TRAIN</span></div>` +
    `<p style="margin:1.5rem 0;font-size:1.05rem">${msg}</p>` +
    `<p><a href="/app/" style="color:#cc5520;font-weight:600">Go to your account</a></p></body>`,
    { status, headers: { 'Content-Type': 'text/html' } },
  );
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const u = new URL(request.url);
  const c = u.searchParams.get('c') || '';
  const t = u.searchParams.get('t') || '';
  if (!c || !t || !env.SESSION_HMAC_SECRET) return page('This unsubscribe link is invalid.', 400);

  const valid = await hmacVerify(env.SESSION_HMAC_SECRET, `unsub:${c}`, t);
  if (!valid) return page('This unsubscribe link is invalid.', 400);

  const cust = await one(env.DB, `SELECT id FROM customers WHERE id = ?`, c);
  if (!cust) return page("We couldn't find that account.", 404);

  // Turn marketing email off (other prefs keep their column defaults / existing values).
  await run(env.DB,
    `INSERT INTO notification_prefs (customer_id, email_marketing, updated_at) VALUES (?, 0, ?)
     ON CONFLICT(customer_id) DO UPDATE SET email_marketing = 0, updated_at = excluded.updated_at`,
    c, nowIso());
  return page("You're unsubscribed from menu + reminder emails. You'll still get billing and account emails. You can re-enable these anytime in your account settings.");
}
