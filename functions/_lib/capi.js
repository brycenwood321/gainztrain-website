// Meta Conversions API (server-side events) — the reliable half of Meta tracking: fires actual
// Lead/Purchase events from OUR backend so ad optimization learns from real signups and real money,
// not just pixel clicks (which ad blockers and iOS eat). ENV-GATED NO-OP until Brycen creates the
// pixel in Meta Business Manager and sets META_PIXEL_ID + META_CAPI_TOKEN in Cloudflare Pages env.
// Emails/phones are SHA-256 hashed per Meta spec. Must never break a caller — swallow everything.
import { sha256hex } from './crypto.js';

export async function capiEvent(env, eventName, { email, phone, value_cents, event_id, source_url } = {}) {
  try {
    if (!env.META_PIXEL_ID || !env.META_CAPI_TOKEN) return;
    const user_data = {};
    if (email) user_data.em = [await sha256hex(String(email).trim().toLowerCase())];
    if (phone) user_data.ph = [await sha256hex(String(phone).replace(/[^0-9]/g, ''))];
    if (!user_data.em && !user_data.ph) return; // Meta requires at least one identifier
    const evt = {
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_source_url: source_url || 'https://gainztrainprep.com/start/',
      user_data,
    };
    if (event_id) evt.event_id = event_id; // dedup key shared with the browser pixel when it exists
    if (value_cents != null) evt.custom_data = { currency: 'USD', value: Math.round(value_cents) / 100 };
    await fetch(`https://graph.facebook.com/v21.0/${env.META_PIXEL_ID}/events?access_token=${encodeURIComponent(env.META_CAPI_TOKEN)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [evt] }),
    });
  } catch { /* tracking must never break the business path */ }
}
