// GHL = comms-only. The app renders every dynamic value itself and hands GHL a finished
// string — GHL never does merge-tag substitution, so the {{leak}} / "(Insert link)" bug
// class is structurally impossible. Every send is logged to comms_log for the watchdog.
import { run, nowIso } from './db.js';
import { randomToken } from './crypto.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';

// channel: 'email' | 'sms'. body is the FULLY rendered message (no GHL variables).
export async function ghlSend(env, { customerId = null, contactId, channel, template, subject, body }) {
  let ghlStatus = 'failed';
  // On failure, the HTTP status + error body go to audit_log. The 7-day token outage produced ZERO
  // diagnostic rows because this used to keep only ok/not-ok; a 401 and a rate-limit both read as
  // 'failed'. comms_log's shape is load-bearing (audit + dedup consumers), so the detail rides
  // audit_log instead of a schema change.
  let errorDetail = null;
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
      if (r.ok) {
        ghlStatus = 'sent';
      } else {
        ghlStatus = 'failed';
        const errBody = await r.text().catch(() => '');
        errorDetail = { http_status: r.status, body: errBody.slice(0, 500) };
      }
    } catch (e) {
      ghlStatus = 'failed';
      errorDetail = { http_status: 0, body: `threw: ${String(e).slice(0, 300)}` };
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
  if (errorDetail) {
    try {
      await run(env.DB,
        `INSERT INTO audit_log (at, actor, entity, action, detail_json) VALUES (?, 'ghl', ?, 'ghl_send_failed', ?)`,
        nowIso(), `contact:${contactId}`,
        JSON.stringify({ template, channel, customer_id: customerId, ...errorDetail }).slice(0, 2000));
    } catch { /* diagnostics must never fail the caller */ }
  }
  return ghlStatus;
}

// Push a phone number onto an EXISTING GHL contact. ghlEnsureContact only fires when a customer has
// no contact id yet, so a contact created before the customer had a phone never learns it. That is
// how 4 of 20 pickup customers were silently unreachable by SMS on 2026-08-30. phone-sync.js repairs
// the fleet weekly; customer-edit pushes on change.
export async function ghlUpdatePhone(env, contactId, phone) {
  if (!env.GAINZ_GHL_TOKEN || env.GAINZ_GHL_TOKEN === 'PLACEHOLDER_SET_LATER' || !contactId || !phone) return false;
  try {
    const r = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${env.GAINZ_GHL_TOKEN}`, Version: '2021-07-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    return r.ok;
  } catch { return false; }
}

// Read one GHL contact (the phone check needs GHL's stored value, not our copy of it).
export async function ghlGetContact(env, contactId) {
  if (!env.GAINZ_GHL_TOKEN || env.GAINZ_GHL_TOKEN === 'PLACEHOLDER_SET_LATER' || !contactId) return null;
  try {
    const r = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${env.GAINZ_GHL_TOKEN}`, Version: '2021-07-28' },
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.contact || d || null;
  } catch { return null; }
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

// ── Inbound (added 2026-09-14) ─────────────────────────────────────────────────────────────────────
// Everything above SENDS. This reads: the newest thing the customer said to us, for the ops Customers
// tab and the Monday email. Two calls per contact (search the contact's conversations, then read the
// newest conversation's messages), so callers run it in small passes, never across the whole list.
//
// pickLastInbound is pure and tested: TYPE_ACTIVITY_* rows are GHL's own log lines (opportunity
// created, appointment booked) and never a reply; automation emails are outbound anyway.
export function pickLastInbound(messages) {
  let best = null;
  for (const m of Array.isArray(messages) ? messages : []) {
    if ((m.direction || '') !== 'inbound') continue;
    const mt = String(m.messageType || '');
    if (mt.startsWith('TYPE_ACTIVITY')) continue;
    const at = m.dateAdded ? new Date(m.dateAdded).toISOString() : null;
    if (!at) continue;
    if (!best || at > best.at) {
      const channel = mt === 'TYPE_SMS' ? 'sms' : (mt === 'TYPE_EMAIL' ? 'email' : 'other');
      best = { at, channel, text: String(m.body || '').replace(/\s+/g, ' ').trim().slice(0, 280) };
    }
  }
  return best;
}

export async function ghlLastInbound(env, contactId) {
  if (!env.GAINZ_GHL_TOKEN || env.GAINZ_GHL_TOKEN === 'PLACEHOLDER_SET_LATER' || !env.GAINZ_GHL_LOCATION || !contactId) return { ok: false, reason: 'no_config' };
  const headers = { Authorization: `Bearer ${env.GAINZ_GHL_TOKEN}`, Version: '2021-07-28' };
  try {
    const q = new URLSearchParams({ locationId: env.GAINZ_GHL_LOCATION, contactId, limit: '3' });
    const r = await fetch(`${GHL_BASE}/conversations/search?${q}`, { headers });
    if (!r.ok) return { ok: false, reason: `search_${r.status}` };
    const convos = (await r.json())?.conversations || [];
    if (!convos.length) return { ok: true, last: null };
    // Newest conversation first; GHL returns them sorted by last message, but sort anyway.
    convos.sort((a, b) => (b.lastMessageDate || 0) - (a.lastMessageDate || 0));
    let best = null;
    for (const c of convos.slice(0, 2)) {
      const mr = await fetch(`${GHL_BASE}/conversations/${c.id}/messages?limit=30`, { headers });
      if (!mr.ok) return { ok: false, reason: `messages_${mr.status}` };
      const msgs = (await mr.json())?.messages?.messages || [];
      const cand = pickLastInbound(msgs);
      if (cand && (!best || cand.at > best.at)) best = cand;
    }
    return { ok: true, last: best };
  } catch (e) {
    return { ok: false, reason: `threw: ${String(e && e.message).slice(0, 80)}` };
  }
}
