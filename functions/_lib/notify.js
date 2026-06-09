// notify() — the ONE path for every customer notification. Wraps ghlSend with:
//   1. Idempotency: an optional dedupKey claims a comms_log row (unique index) BEFORE sending, so a
//      Stripe webhook retry that re-runs dispatch() can't double-send (see migrations/0007).
//   2. Template rendering: pure (data)=>{subject,html,sms} functions — no GHL merge tags, so the old
//      "(Insert billing link)" leak class can't recur.
//   3. Channel fan-out: email always; SMS only when env.SMS_AUTH_ENABLED === 'true' (A2P gate).
//   4. Non-blocking by contract: callers should still try/catch, but notify() itself never throws on a
//      comms failure — a hiccup must never break the underlying business action or fail a webhook.
import { one, run, nowIso } from './db.js';
import { randomToken, hmacSign } from './crypto.js';
import { ghlEnsureContact, ghlSend } from './ghl.js';
import { TEMPLATES } from './notify_templates.js';

// Preference class per event. 'critical' = transactional/security, ALWAYS sends (not opt-out-able).
// 'account' = self-service confirmations. 'marketing' = menu drops / reminders / renewal heads-up.
const PREF_CLASS = {
  welcome: 'critical', password_changed: 'critical',
  order_receipt_first: 'critical', renewal_receipt: 'critical', payment_failed: 'critical',
  payment_failed_final: 'critical', payment_recovered: 'critical', refund_issued: 'critical',
  subscription_ended: 'critical', card_expiring: 'critical',
  order_confirmed: 'critical', order_updated: 'critical', order_locked: 'critical', order_autofilled: 'critical',
  order_prepped: 'critical', order_out_for_delivery: 'critical', order_pickup_ready: 'critical', order_delivered: 'critical',
  paused: 'account', resumed: 'account', canceled: 'account', reactivated: 'account',
  tier_changed: 'account', delivery_changed: 'account', goal_changed: 'account',
  menu_posted: 'marketing', meal_reminder: 'marketing', meal_reminder_final: 'marketing', renewal_upcoming: 'marketing',
};

function appBase(env) { return (env && (env.APP_BASE_URL || env.GT_APP_BASE_URL)) || 'https://gainztrainprep.com'; }

// Which bucket each event belongs to (drives the in-app feed icon + deep link).
const CATEGORY = {
  welcome: 'account', password_changed: 'account', paused: 'account', resumed: 'account',
  canceled: 'account', reactivated: 'account', tier_changed: 'account', delivery_changed: 'account',
  goal_changed: 'account',
  order_receipt_first: 'billing', renewal_receipt: 'billing', payment_failed: 'billing',
  payment_failed_final: 'billing', payment_recovered: 'billing', refund_issued: 'billing',
  subscription_ended: 'billing', renewal_upcoming: 'billing', card_expiring: 'billing',
  menu_posted: 'order', order_confirmed: 'order', order_updated: 'order', order_locked: 'order',
  order_autofilled: 'order', meal_reminder: 'order', meal_reminder_final: 'order',
  order_prepped: 'order', order_out_for_delivery: 'order', order_pickup_ready: 'order', order_delivered: 'order',
};
const HREF = { account: '/app/manage/', billing: '/app/manage/', order: '/app/menu/' };

// notify(env, customer, eventKey, data?, opts?)
//   customer : a customers row (needs id, email; ghl_contact_id/first_name/last_name/phone help)
//   eventKey : key into TEMPLATES
//   data     : values the template renders
//   opts     : { dedupKey?: string }  — set for webhook/cron events; omit for user-initiated clicks
// Returns { ok, deduped?, reason?, results? } and never throws.
export async function notify(env, customer, eventKey, data = {}, opts = {}) {
  try {
    const tpl = TEMPLATES[eventKey];
    if (!tpl) return { ok: false, reason: 'no_template' };
    if (!customer || !customer.id) return { ok: false, reason: 'no_customer' };

    // ── Idempotency claim ──: insert a marker row keyed on dedupKey. The unique index makes the
    // second attempt a no-op (0 changes) → we skip the send. This happens BEFORE any GHL call so a
    // concurrent retry can't slip a duplicate through between check and send.
    if (opts.dedupKey) {
      const claim = await run(
        env.DB,
        `INSERT INTO comms_log (id, customer_id, contact_id, channel, template, body, ghl_status, sent_at, dedup_key)
         VALUES (?, ?, NULL, 'notify', ?, '', 'claimed', ?, ?)
         ON CONFLICT(dedup_key) DO NOTHING`,
        randomToken(12), customer.id, eventKey, nowIso(), opts.dedupKey,
      );
      if (!claim?.meta?.changes) return { ok: true, deduped: true };
    }

    const rendered = tpl(data, env) || {};

    // ── Preferences ── critical (transactional/security) always sends. account/marketing respect the
    // customer's opt-outs; no prefs row = all defaults (account+marketing email on, sms_marketing off).
    let cls = PREF_CLASS[eventKey];
    if (!cls) {
      // FAIL-CLOSED: an unmapped event must never be silently opt-out-able on a money system. Treat as
      // critical (always sends) and log so a future marketing event can't slip through un-classified.
      cls = 'critical';
      try { await run(env.DB, `INSERT INTO audit_log (at, actor, entity, action, detail_json) VALUES (?, 'notify', ?, 'unmapped_pref_class', ?)`, nowIso(), `event:${eventKey}`, JSON.stringify({ eventKey })); } catch { /* ignore */ }
    }
    let prefs = null;
    if (cls !== 'critical') {
      try { prefs = await one(env.DB, `SELECT email_account, email_marketing, sms_account, sms_marketing FROM notification_prefs WHERE customer_id = ?`, customer.id); } catch { prefs = null; }
    }
    let emailAllowed = cls === 'critical' || !prefs || (cls === 'account' ? prefs.email_account : prefs.email_marketing) !== 0;
    const smsAllowed = cls === 'critical' || !prefs || (cls === 'account' ? prefs.sms_account : prefs.sms_marketing) !== 0;

    // Marketing email REQUIRES a one-click CAN-SPAM unsubscribe footer (transactional never gets one).
    // FAIL-CLOSED: if we can't build the footer, suppress the send rather than mail a non-compliant
    // message from a fresh sending domain.
    if (cls === 'marketing' && emailAllowed && rendered.html) {
      let footered = false;
      if (env.SESSION_HMAC_SECRET) {
        try {
          const sig = await hmacSign(env.SESSION_HMAC_SECRET, `unsub:${customer.id}`);
          const url = `${appBase(env)}/api/unsubscribe?c=${encodeURIComponent(customer.id)}&t=${sig}`;
          rendered.html += `<div style="font-size:11px;color:#9a928e;margin-top:10px">You're getting menu + reminder emails. <a href="${url}" style="color:#9a928e;text-decoration:underline">Unsubscribe from these</a> — you'll still get billing + account emails.</div>`;
          footered = true;
        } catch { footered = false; }
      }
      if (!footered) {
        emailAllowed = false;
        try { await run(env.DB, `INSERT INTO audit_log (at, actor, entity, action, detail_json) VALUES (?, 'notify', ?, 'marketing_suppressed_no_footer', ?)`, nowIso(), `customer:${customer.id}`, JSON.stringify({ eventKey })); } catch { /* ignore */ }
      }
    }

    const wantEmail = emailAllowed && (rendered.html || rendered.subject);
    const wantSms = smsAllowed && rendered.sms && String(env.SMS_AUTH_ENABLED) === 'true';

    // Resolve the GHL contact once (lazy-create + persist) and reuse it for both channels — but only if
    // we're actually going to send something (an opted-out customer needs no contact lookup).
    let contactId = customer.ghl_contact_id || null;
    if (!contactId && (wantEmail || wantSms)) {
      contactId = await ghlEnsureContact(env, {
        email: customer.email, firstName: customer.first_name, lastName: customer.last_name, phone: customer.phone,
      });
      if (contactId) {
        try { await run(env.DB, `UPDATE customers SET ghl_contact_id = ?, updated_at = ? WHERE id = ?`, contactId, nowIso(), customer.id); } catch { /* non-fatal */ }
      }
    }

    const results = {};
    if (wantEmail) {
      results.email = await ghlSend(env, {
        customerId: customer.id, contactId, channel: 'email',
        template: eventKey, subject: rendered.subject, body: rendered.html || rendered.subject,
      });
    }
    // SMS stays built-but-gated until A2P clears (wantSms already folds in the A2P + prefs gates).
    if (wantSms) {
      results.sms = await ghlSend(env, {
        customerId: customer.id, contactId, channel: 'sms', template: eventKey, body: rendered.sms,
      });
    }
    // Claim-then-CONFIRM: if the email leg actually FAILED (real GHL error, not the dev no-token /
    // no-contact 'queued_no_token' case), release the dedup claim so a webhook retry can re-attempt.
    // Without this, at-most-once silently degrades to never-sent on a transient GHL outage.
    if (opts.dedupKey && results.email === 'failed') {
      try { await run(env.DB, `DELETE FROM comms_log WHERE dedup_key = ? AND ghl_status = 'claimed'`, opts.dedupKey); } catch { /* best effort */ }
      return { ok: false, reason: 'send_failed', results };
    }

    // In-app feed row (best-effort; table is migration 0008). Reached only on the success path — a
    // deduped call or a released failed-claim already returned above, so each logical notification
    // yields at most one feed row, and a retry after a real failure writes it exactly once.
    try {
      const cat = CATEGORY[eventKey] || 'account';
      const body = (rendered.sms || '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim() || null;
      await run(env.DB,
        `INSERT INTO notifications (id, customer_id, event_key, title, body, href, category, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        randomToken(12), customer.id, eventKey, rendered.subject || eventKey, body, HREF[cat] || '/app/', cat, nowIso());
    } catch { /* in-app feed is best-effort (table may not exist pre-migration 0008) */ }

    return { ok: true, results };
  } catch (e) {
    // Never throw — record best-effort and move on.
    try { await run(env.DB, `INSERT INTO audit_log (at, actor, entity, action, detail_json) VALUES (?, 'notify', ?, 'notify_failed', ?)`, nowIso(), `customer:${customer?.id || '?'}`, JSON.stringify({ eventKey, error: String(e).slice(0, 200) })); } catch { /* ignore */ }
    return { ok: false, reason: 'threw' };
  }
}
