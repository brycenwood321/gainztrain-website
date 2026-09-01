// ownerNotify() — tells the OWNERS (Brycen / Jayson) when a customer does something that matters:
// signup, cancel, pause, resume, tier change, payment failure, refund.
//
// Two layers, independent:
//   1. ALWAYS: write an audit_log row. This powers the /app/ops "Activity" feed and costs nothing, so
//      the owners can always see what happened even with sends turned off.
//   2. OPTIONAL sends, gated by env so nothing fires until the owner opts in:
//        OWNER_NOTIFY_ENABLED='true'   master switch for email + SMS
//        OWNER_NOTIFY_EMAILS='a@x,b@y' comma list — every event emails these
//        OWNER_NOTIFY_SMS='+1801...'   comma list — BIG events also text these (needs SMS_AUTH_ENABLED)
//   Never throws — an owner-alert failure must never break the customer's action or fail a webhook.
import { run, nowIso } from './db.js';
import { ghlEnsureContact, ghlSend } from './ghl.js';

// Events important enough to also fire an instant SMS (money-moving / churn). Everything emails.
// owner_health_alert added 2026-08-31, Brycen's call after the 7-day comms outage: a health page
// that only emails through the same channel that is failing is not a page.
const BIG = new Set(['owner_new_signup', 'owner_canceled', 'owner_payment_failed', 'owner_tier_changed', 'owner_refund', 'owner_menu_failsafe', 'owner_health_alert']);

function list(env, key) {
  return String((env && env[key]) || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// ownerNotify(env, eventKey, summary, detail?)
//   eventKey : owner_* key (drives the BIG/SMS decision + the audit action)
//   summary  : one-line human string ("Jesus Lopez canceled — 11 meals/wk, ends Jun 21")
//   detail   : { entity?, lines?: string[], ...anything } — entity tags the audit row; lines = email bullets
export async function ownerNotify(env, eventKey, summary, detail = {}) {
  // Layer 1 — always record (best-effort).
  try {
    await run(env.DB, `INSERT INTO audit_log (at, actor, entity, action, detail_json) VALUES (?, 'owner', ?, ?, ?)`,
      nowIso(), detail.entity || 'system', eventKey, JSON.stringify({ summary, ...detail }).slice(0, 2000));
  } catch { /* non-fatal */ }

  // Layer 2 — optional sends.
  try {
    if (String(env.OWNER_NOTIFY_ENABLED) !== 'true') return { ok: true, skipped: 'disabled' };
    const emails = list(env, 'OWNER_NOTIFY_EMAILS');
    const subject = `GT: ${summary}`.slice(0, 120);
    const bullets = Array.isArray(detail.lines) && detail.lines.length
      ? '<ul>' + detail.lines.map((l) => `<li>${String(l)}</li>`).join('') + '</ul>' : '';
    const html = `<p style="font:15px system-ui">${summary}</p>${bullets}` +
      `<p style="font:12px system-ui;color:#888">Gainz Train ops alert · <a href="https://gainztrainprep.com/app/ops/">open ops</a></p>`;
    for (const email of emails) {
      const cid = await ghlEnsureContact(env, { email, firstName: 'GT', lastName: 'Owner' });
      if (cid) await ghlSend(env, { customerId: null, contactId: cid, channel: 'email', template: eventKey, subject, body: html });
    }
    // SMS for BIG events (uses the same owner email-contacts, so their phone in GHL receives it).
    if (BIG.has(eventKey) && String(env.SMS_AUTH_ENABLED) === 'true') {
      for (const email of emails) {
        const cid = await ghlEnsureContact(env, { email });
        if (cid) await ghlSend(env, { customerId: null, contactId: cid, channel: 'sms', template: eventKey, body: summary.slice(0, 150) });
      }
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
