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

// GET renders a CONFIRMATION, it does not unsubscribe.
//
// ⚠️ This endpoint used to mutate on GET. Outlook SafeLinks, Gmail's proxy and other corporate link
// scanners fetch every URL in delivered mail, so one scan silently switched a customer's menu and
// reminder emails off — they never clicked anything and nothing told them. Same failure class as the
// magic-link prefetch problem fixed 2026-06-10 with an interstitial; that fix was never applied here.
// A real person clicking still unsubscribes in one extra tap, and a bot following the link changes
// nothing. Keep the mutation on POST.
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

  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  return page(
    'Turn off menu drops and meal reminders?' +
    '<form method="POST" style="margin-top:1.5rem">' +
    `<input type="hidden" name="c" value="${esc(c)}"><input type="hidden" name="t" value="${esc(t)}">` +
    '<button type="submit" style="background:#ff6b35;color:#fff;border:none;font-weight:700;' +
    'padding:.8rem 1.4rem;border-radius:10px;font-size:1rem;cursor:pointer">Yes, unsubscribe me</button>' +
    '</form>' +
    '<p style="font-size:.85rem;color:#7a7270;margin-top:1.2rem">You\'ll still get billing and account ' +
    'emails — those aren\'t marketing and can\'t be turned off.</p>',
  );
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const u = new URL(request.url);
  let c = u.searchParams.get('c') || '';
  let t = u.searchParams.get('t') || '';
  // The confirmation form posts them in the body; a direct POST may still use the query string.
  if (!c || !t) {
    try {
      const form = await request.formData();
      c = c || String(form.get('c') || '');
      t = t || String(form.get('t') || '');
    } catch { /* no form body */ }
  }
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
