// GET /api/auth/verify?token=... — consume a magic link, start a session, redirect into the app.
import { one, run, nowIso } from '../../_lib/db.js';
import { sha256hex } from '../../_lib/crypto.js';
import { createSession } from '../../_lib/auth.js';

function pageError(msg) {
  return new Response(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<body style="font-family:system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem;text-align:center">` +
      `<h2>Gainz Train</h2><p>${msg}</p><p><a href="/app/">Back to login</a></p></body>`,
    { status: 400, headers: { 'Content-Type': 'text/html' } },
  );
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const raw = new URL(request.url).searchParams.get('token') || '';
  if (!raw) return pageError('Missing login token.');

  const tokenHash = await sha256hex(raw);
  const row = await one(env.DB, `SELECT * FROM auth_tokens WHERE token_hash = ? AND kind = 'magic_link'`, tokenHash);
  const now = nowIso();
  if (!row || row.consumed_at || row.expires_at < now) {
    return pageError('This login link is invalid or has expired. Please request a new one.');
  }

  await run(env.DB, `UPDATE auth_tokens SET consumed_at = ? WHERE id = ?`, now, row.id);
  const { cookie } = await createSession(env, row.customer_id, request);
  return new Response(null, { status: 302, headers: { Location: '/app/', 'Set-Cookie': cookie } });
}
