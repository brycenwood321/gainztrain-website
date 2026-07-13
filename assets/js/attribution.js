// First-touch marketing attribution + page-view beacon (GT_MARKETING_PLAN §6, Phase 1).
// Included on public entry pages. Two jobs:
// 1. FIRST TOUCH: if the URL carries UTMs / ad click-ids, or the visitor arrived from an external
//    referrer, store it ONCE in localStorage (first touch wins — a later direct visit never
//    overwrites the ad click that started it). /start reads this at signup → attribution table.
// 2. VIEW BEACON: report a PII-free page view (path + utm + referrer host, no cookies/IP/id) to
//    /api/t so the ops Marketing funnel can show views → leads → customers per source in-house.
(function () {
  try {
    var KEY = 'gt_attr';
    var q = new URLSearchParams(location.search);
    var a = {};
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid']
      .forEach(function (k) { var v = q.get(k); if (v) a[k] = String(v).slice(0, 120); });
    var ref = document.referrer || '';
    var external = ref && ref.indexOf('//' + location.host) === -1;
    var had = false;
    try { had = !!localStorage.getItem(KEY); } catch (e) {}

    if (!had && (Object.keys(a).length || external)) {
      var ft = {};
      for (var k in a) ft[k] = a[k];
      ft.landing_path = (location.pathname + location.search).slice(0, 300);
      if (external) ft.referrer = ref.slice(0, 300);
      ft.first_touch_at = new Date().toISOString();
      try { localStorage.setItem(KEY, JSON.stringify(ft)); } catch (e) {}
    }

    // Page-view beacon: current visit's context (not the stored first touch) = honest per-visit counts.
    var refHost = '';
    if (external) { try { refHost = new URL(ref).host.slice(0, 120); } catch (e) {} }
    var pv = JSON.stringify({
      path: location.pathname.slice(0, 200),
      utm_source: a.utm_source || null, utm_medium: a.utm_medium || null,
      utm_campaign: a.utm_campaign || null, utm_content: a.utm_content || null,
      referrer_host: refHost || null, returning: had ? 1 : 0,
    });
    if (!(navigator.sendBeacon && navigator.sendBeacon('/api/t', new Blob([pv], { type: 'application/json' })))) {
      fetch('/api/t', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: pv, keepalive: true }).catch(function () {});
    }
  } catch (e) { /* attribution must never break a page */ }
})();

// Meta Pixel (browser side). Complements the server-side CAPI in functions/_lib/capi.js:
// browser owns PageView (+ fbclid→_fbc matching for ad attribution); the server owns Lead and
// Purchase, so the two sides never double-count the same event. Pixel ID is public by design.
(function () {
  try {
    if (window.fbq) return;
    var n = window.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
    if (!window._fbq) window._fbq = n;
    n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
    var t = document.createElement('script');
    t.async = true; t.src = 'https://connect.facebook.net/en_US/fbevents.js';
    var s = document.getElementsByTagName('script')[0];
    s.parentNode.insertBefore(t, s);
    fbq('init', '2006885166604741');
    fbq('track', 'PageView');
  } catch (e) { /* pixel must never break a page */ }
})();
