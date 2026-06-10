// /api/auth/verify?token=... — consume a magic link, start a session, redirect into the app.
//
// PREFETCH SAFETY: email security scanners (Gmail/Outlook/Proofpoint) issue a GET on every link in an
// email before the human ever clicks. If GET consumed the token, the human would always land on
// "already used." So GET only renders a one-button interstitial; the token is consumed on the POST that
// the human's click submits. Bots don't run JS or submit forms, so they can't burn the token.
import { one, run, nowIso } from '../../_lib/db.js';
import { sha256hex } from '../../_lib/crypto.js';
import { createSession } from '../../_lib/auth.js';

function page(bodyHtml, status = 200) {
  return new Response(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<body style="font-family:system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem;text-align:center">` +
      `<h2>Gainz Train</h2>${bodyHtml}</body>`,
    { status, headers: { 'Content-Type': 'text/html' } },
  );
}

function pageError(msg) {
  return page(`<p>${msg}</p><p><a href="/app/">Back to login</a></p>`, 400);
}

// GET = render the "Continue" button (no token consumption). A scanner's prefetch stops here.
export async function onRequestGet(context) {
  const raw = new URL(context.request.url).searchParams.get('token') || '';
  if (!raw) return pageError('Missing login token.');
  // The form re-submits the token via POST; we don't validate it here so we don't leak whether it's
  // valid to a prefetcher. The real check happens on POST.
  const safe = raw.replace(/[^a-f0-9]/gi, '').slice(0, 128); // tokens are hex; strip anything else
  return page(
    `<p>Click below to finish logging in.</p>` +
      `<form method="POST" action="/api/auth/verify">` +
      `<input type="hidden" name="token" value="${safe}">` +
      `<button type="submit" style="font:inherit;padding:.7rem 1.4rem;border:0;border-radius:.5rem;` +
      `background:#e63b2e;color:#fff;font-weight:600;cursor:pointer">Log in →</button></form>`,
  );
}

// POST = the human clicked Continue. Consume the token (atomic single-use) and mint the session.
export async function onRequestPost(context) {
  const { request, env } = context;
  let raw = '';
  try {
    const form = await request.formData();
    raw = String(form.get('token') || '');
  } catch { /* fall through to missing-token error */ }
  if (!raw) return pageError('Missing login token.');

  const tokenHash = await sha256hex(raw);
  const row = await one(env.DB, `SELECT * FROM auth_tokens WHERE token_hash = ? AND kind = 'magic_link'`, tokenHash);
  const now = nowIso();
  if (!row || row.consumed_at || row.expires_at < now) {
    return pageError('This login link is invalid or has expired. Please request a new one.');
  }

  // Atomic single-use: only the first request that flips consumed_at wins.
  const claim = await run(env.DB, `UPDATE auth_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`, now, row.id);
  if (!claim?.meta?.changes) {
    return pageError('This login link was already used. Please request a new one.');
  }
  const { cookie } = await createSession(env, row.customer_id, request);
  // Land on the set-password page (they likely came from "forgot password") so they can set a real
  // password instead of being dropped on the dashboard and forgetting again. They can skip to /app.
  return new Response(null, { status: 302, headers: { Location: '/app/reset/', 'Set-Cookie': cookie } });
}
