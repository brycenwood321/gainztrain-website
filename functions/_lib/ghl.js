// GHL = comms-only. The app renders every dynamic value itself and hands GHL a finished
// string — GHL never does merge-tag substitution, so the {{leak}} / "(Insert link)" bug
// class is structurally impossible. Every send is logged to comms_log for the watchdog.
import { run, nowIso } from './db.js';
import { randomToken } from './crypto.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';

// channel: 'email' | 'sms'. body is the FULLY rendered message (no GHL variables).
export async function ghlSend(env, { customerId = null, contactId, channel, template, subject, body }) {
  let ghlStatus = 'failed';
  if (env.GAINZ_GHL_TOKEN && env.GAINZ_GHL_TOKEN !== 'PLACEHOLDER_SET_LATER' && contactId) {
    try {
      const payload =
        channel === 'sms'
          ? { type: 'SMS', contactId, message: body }
          : { type: 'Email', contactId, subject: subject || 'Gainz Train', html: body, message: body };
      const r = await fetch(`${GHL_BASE}/conversations/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.GAINZ_GHL_TOKEN}`,
          Version: '2021-07-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      ghlStatus = r.ok ? 'sent' : 'failed';
    } catch {
      ghlStatus = 'failed';
    }
  } else {
    // No token configured (local/dev) — record as queued so nothing silently vanishes.
    ghlStatus = 'queued_no_token';
  }

  await run(
    env.DB,
    `INSERT INTO comms_log (id, customer_id, contact_id, channel, template, body, ghl_status, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    randomToken(12),
    customerId,
    contactId,
    channel,
    template,
    body,
    ghlStatus,
    nowIso(),
  );
  return ghlStatus;
}

// Create-or-find a GHL contact by email (idempotent upsert). Returns the contact id, or null.
// App-created customers aren't GHL contacts, so transactional email (magic link, welcome) needs this.
export async function ghlEnsureContact(env, { email, firstName, lastName, phone }) {
  if (!env.GAINZ_GHL_TOKEN || env.GAINZ_GHL_TOKEN === 'PLACEHOLDER_SET_LATER' || !env.GAINZ_GHL_LOCATION || !email) return null;
  try {
    const r = await fetch(`${GHL_BASE}/contacts/upsert`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GAINZ_GHL_TOKEN}`, Version: '2021-07-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ locationId: env.GAINZ_GHL_LOCATION, email, firstName: firstName || undefined, lastName: lastName || undefined, phone: phone || undefined }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.contact?.id || d?.id || null;
  } catch { return null; }
}

// Send to a customer, lazily creating + persisting their GHL contact id if it's missing. This is the
// path that makes magic-link + welcome emails actually reach an app-created customer.
export async function ghlSendToCustomer(env, customer, msg) {
  let contactId = customer.ghl_contact_id;
  if (!contactId) {
    contactId = await ghlEnsureContact(env, { email: customer.email, firstName: customer.first_name, lastName: customer.last_name, phone: customer.phone });
    if (contactId) {
      try { await run(env.DB, `UPDATE customers SET ghl_contact_id = ?, updated_at = ? WHERE id = ?`, contactId, nowIso(), customer.id); } catch { /* non-fatal */ }
    }
  }
  return ghlSend(env, { customerId: customer.id, contactId, ...msg });
}

// Add a tag to a GHL contact (the allowed one-step "tag → static template" trigger pattern).
export async function ghlAddTag(env, contactId, tag) {
  if (!env.GAINZ_GHL_TOKEN || env.GAINZ_GHL_TOKEN === 'PLACEHOLDER_SET_LATER' || !contactId) return false;
  try {
    const r = await fetch(`${GHL_BASE}/contacts/${contactId}/tags`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GAINZ_GHL_TOKEN}`,
        Version: '2021-07-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tags: [tag] }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
