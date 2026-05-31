// POST /api/auth/request-link — email a one-time magic login link.
// Always returns the SAME generic response so it never leaks who is a member.
import { ok, fail, readJson } from '../../_lib/respond.js';
import { one, all, run, nowIso, addMinutesIso } from '../../_lib/db.js';
import { randomToken, sha256hex } from '../../_lib/crypto.js';
import { ghlSend } from '../../_lib/ghl.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await readJson(request);
  const email = (body.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return fail(400, 'invalid_email', 'Enter a valid email address.');

  const devExpose = (env.APP_BASE_URL || '').includes('localhost');
  const generic = (extra = {}) => ok({ message: 'If that email is on file, a login link is on its way.', ...extra });

  const customer = await one(env.DB, `SELECT id, ghl_contact_id, first_name FROM customers WHERE email = ?`, email);
  if (!customer) return generic();

  // Rate limit: no more than 5 unconsumed, unexpired magic links per customer at a time.
  const recent = await all(
    env.DB,
    `SELECT id FROM auth_tokens WHERE customer_id = ? AND kind = 'magic_link' AND consumed_at IS NULL AND expires_at > ?`,
    customer.id, nowIso(),
  );
  if (recent.length >= 5) return generic();

  const raw = randomToken(32);
  const tokenHash = await sha256hex(raw);
  await run(
    env.DB,
    `INSERT INTO auth_tokens (id, customer_id, kind, token_hash, expires_at, created_ip, created_at)
     VALUES (?, ?, 'magic_link', ?, ?, ?, ?)`,
    randomToken(12), customer.id, tokenHash, addMinutesIso(15), request.headers.get('cf-connecting-ip') || '', nowIso(),
  );

  const link = `${env.APP_BASE_URL || ''}/api/auth/verify?token=${raw}`;
  const greeting = customer.first_name ? ` ${customer.first_name}` : '';
  const html =
    `<p>Hey${greeting},</p>` +
    `<p>Tap below to log into your Gainz Train account:</p>` +
    `<p><a href="${link}">Log in to Gainz Train</a></p>` +
    `<p>This link expires in 15 minutes. If you didn't request it, you can ignore this email.</p>`;

  await ghlSend(env, {
    customerId: customer.id,
    contactId: customer.ghl_contact_id,
    channel: 'email',
    template: 'magic_link',
    subject: 'Your Gainz Train login link',
    body: html,
  });

  // In local dev only, return the link so the flow is testable without an email inbox.
  return generic(devExpose ? { dev_magic_link: link } : {});
}
