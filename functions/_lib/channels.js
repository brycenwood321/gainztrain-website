// ONE definition of "which channel did this come from", shared by /api/admin/attribution,
// /api/admin/channel-report and /api/admin/marketing-weekly so the views can never drift.
//
// ⚠️ THE INPUT MATTERS MORE THAN THE REGEXES (2026-09-02). 744 of 941 sessions in a 30-day window had
// NULL utm_source; Google (92) and ChatGPT (14) existed ONLY in entry_referrer_host. A classifier fed
// utm_source alone reports "google: 0" with a straight face. Always feed classify() the whole row.
//
// Order of tests is load-bearing: marketplace before meta (a Marketplace link is utm_source=marketplace;
// a bare facebook click-id is NOT an ad), paid before organic.

export const CHANNELS = ['meta-ads', 'meta-organic', 'marketplace', 'google-ads', 'google', 'chatgpt', 'tiktok', 'direct', 'other', 'unattributed'];

const host = (v) => {
  const s = String(v || '').toLowerCase();
  const m = s.match(/^(?:https?:\/\/)?([^/?#]+)/);
  return m ? m[1] : s;
};

// row: { utm_source, utm_medium, referrer_host | referrer, ad_id, fbclid, gclid }
export function classify(row) {
  const src = String(row.utm_source || '').toLowerCase().trim();
  const med = String(row.utm_medium || '').toLowerCase().trim();
  const ref = host(row.referrer_host || row.referrer || '');
  const paid = /^(cpc|ppc|paid|ad|ads|paid_social|paidsocial)$/.test(med) || !!row.ad_id;

  if (/marketplace/.test(src) || /marketplace/.test(med)) return 'marketplace';
  if (/facebook|instagram|^fb$|^ig$|meta/.test(src)) return paid ? 'meta-ads' : 'meta-organic';
  if (row.fbclid || /facebook\.com$|instagram\.com$|^fb\.me$/.test(ref)) return row.ad_id ? 'meta-ads' : 'meta-organic';
  if (/google|gbp|youtube/.test(src)) return paid || row.gclid ? 'google-ads' : 'google';
  if (row.gclid) return 'google-ads';
  if (/google\./.test(ref) || /youtube\.com$/.test(ref)) return 'google';
  if (/tiktok/.test(src) || /tiktok\.com$/.test(ref)) return 'tiktok';
  if (/chatgpt/.test(src) || /chatgpt\.com$|openai\.com$/.test(ref)) return 'chatgpt';
  if (src) return 'other';                         // a utm we do not recognise: visible, never silently direct
  if (!ref || /gainztrainprep\.com$|stripe\.com$/.test(ref)) return 'direct';
  if (/bing\.com$|duckduckgo\.com$|brave\.com$|nortonsafesearch\.com$|yahoo\.com$/.test(ref)) return 'other';
  return 'other';
}

// Legacy string entry point kept for /api/admin/attribution's page_views funnel, which pre-mixes
// utm_source and a referrer label into one string. New code should call classify(row).
export function toChannel(s) {
  const v = String(s || '').toLowerCase();
  if (/marketplace/.test(v)) return 'marketplace';
  if (/facebook|instagram|^fb$|^ig$|meta/.test(v)) return 'meta';
  if (/google|gbp|youtube/.test(v)) return 'google';
  if (/tiktok/.test(v)) return 'tiktok';
  if (/chatgpt/.test(v)) return 'chatgpt';
  if (!v || v === '(direct)' || v === '(organic/direct)' || v === '(blank)') return 'organic/direct';
  return v;
}

// What people SAY at signup ("how did you hear about us?"). Kept separate from first-touch on purpose:
// self-reported over-counts social because it includes Jayson's posts, and under-counts search.
export function selfReportedToChannel(v) {
  const s = String(v || '').toLowerCase();
  if (s === 'facebook_ad') return 'meta-ads';
  if (s === 'facebook_marketplace') return 'marketplace';
  if (s === 'facebook_organic' || s === 'instagram') return 'meta-organic';
  if (s === 'facebook') return 'facebook (before split)';
  if (s === 'google') return 'google';
  if (s === 'tiktok') return 'tiktok';
  if (s === 'friend' || s === 'gym') return 'word-of-mouth';
  if (s === 'other') return 'other';
  return '(blank)';
}
