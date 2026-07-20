// First-party marketing attribution + full web analytics + Meta pixel. Loaded on every page via a
// single shared <script defer>, so one file change reaches the whole site. Three independent blocks,
// each wrapped so it can NEVER break a page:
//   1. FIRST TOUCH  — store the ad click that started the journey once in localStorage (/start reads
//                     it at signup → attribution table).
//   2. ANALYTICS    — anonymous visitor + session ids, pageview w/ dwell + scroll, click/CTA/outbound
//                     + funnel events, all beaconed to /api/t. No PII, no cookies, no IP.
//   3. META PIXEL   — browser PageView (server CAPI owns Lead/Purchase; the two never double-count).

// ── 1. FIRST-TOUCH ATTRIBUTION (unchanged contract: /start reads localStorage 'gt_attr') ──────────
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
  } catch (e) { /* never break a page */ }
})();

// ── 2. WEB ANALYTICS ──────────────────────────────────────────────────────────────────────────────
(function () {
  try {
    var LS = window.localStorage;
    var q = new URLSearchParams(location.search);
    var now = Date.now();
    var SESSION_GAP = 30 * 60 * 1000; // 30 min inactivity = new session

    function rnd() {
      try { return crypto.randomUUID().replace(/-/g, ''); }
      catch (e) { return (now.toString(36) + Math.random().toString(36).slice(2, 12)); }
    }
    function get(k) { try { return LS.getItem(k); } catch (e) { return null; } }
    function set(k, v) { try { LS.setItem(k, v); } catch (e) {} }

    // Persistent anonymous visitor id (new vs returning).
    var vid = get('gt_vid');
    var isReturning = !!vid;
    if (!vid) { vid = rnd(); set('gt_vid', vid); }

    // Session id with a 30-min sliding window.
    var sid = get('gt_sid');
    var lastSeen = parseInt(get('gt_sid_ts') || '0', 10);
    if (!sid || !lastSeen || (now - lastSeen) > SESSION_GAP) { sid = rnd(); }
    set('gt_sid', sid);
    set('gt_sid_ts', String(now));

    var uget = function (k) { var v = q.get(k); return v ? String(v).slice(0, 120) : null; };
    var ref = document.referrer || '';
    var external = ref && ref.indexOf('//' + location.host) === -1;
    var refHost = null;
    if (external) { try { refHost = new URL(ref).host.slice(0, 120); } catch (e) {} }

    var pvId = rnd();
    var activeMs = 0;       // visibility-aware active time
    var lastResume = now;
    var maxScroll = 0;
    var scrollHits = {};    // milestones already sent
    var sentUnload = false;

    function post(body) {
      try {
        var s = JSON.stringify(body);
        if (navigator.sendBeacon && navigator.sendBeacon('/api/t', new Blob([s], { type: 'application/json' }))) return;
        fetch('/api/t', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: s, keepalive: true }).catch(function () {});
      } catch (e) {}
    }

    // Batched events (clicks etc.) flushed on interval + on unload.
    var queue = [];
    function flush() {
      if (!queue.length) return;
      var batch = queue.splice(0, queue.length);
      post({ t: 'events', session_id: sid, visitor_id: vid, path: location.pathname.slice(0, 200), events: batch });
    }
    // Public hook so any page can log a funnel step: window.gtTrack('funnel','menu_add', 6)
    window.gtTrack = function (type, label, value, href) {
      try {
        queue.push({ type: String(type || 'custom').slice(0, 24), label: label ? String(label).slice(0, 120) : null,
                     value: (typeof value === 'number' ? value : null), href: href ? String(href).slice(0, 200) : null,
                     at: new Date().toISOString() });
        if (queue.length >= 10) flush();
      } catch (e) {}
    };

    // 2a. PAGEVIEW — full entry context; server enriches geo + device from the request.
    post({
      t: 'pageview', pv_id: pvId, session_id: sid, visitor_id: vid,
      path: location.pathname.slice(0, 200), title: (document.title || '').slice(0, 160),
      referrer_host: refHost, returning: isReturning ? 1 : 0,
      utm_source: uget('utm_source'), utm_medium: uget('utm_medium'), utm_campaign: uget('utm_campaign'),
      utm_content: uget('utm_content'), utm_term: uget('utm_term'), fbclid: uget('fbclid'), gclid: uget('gclid'),
    });

    // 2b. DWELL — count only foreground time; pause when the tab is hidden.
    function onVis() {
      if (document.visibilityState === 'hidden') { activeMs += Date.now() - lastResume; sendUpdate(); }
      else { lastResume = Date.now(); }
    }
    function currentDwell() { return activeMs + (document.visibilityState === 'hidden' ? 0 : (Date.now() - lastResume)); }

    // 2c. SCROLL depth + milestone events.
    function onScroll() {
      try {
        var h = document.documentElement;
        var denom = (h.scrollHeight - h.clientHeight);
        var pct = denom > 0 ? Math.min(100, Math.round(((h.scrollTop || window.pageYOffset) / denom) * 100)) : 100;
        if (pct > maxScroll) maxScroll = pct;
        [25, 50, 75, 100].forEach(function (m) {
          if (maxScroll >= m && !scrollHits[m]) { scrollHits[m] = 1; window.gtTrack('scroll', m + '%', m); }
        });
      } catch (e) {}
    }

    // 2d. CLICKS — links, buttons, and anything tagged [data-cta]/.btn. Outbound vs internal.
    function onClick(e) {
      try {
        var el = e.target;
        for (var i = 0; i < 4 && el && el !== document.body; i++) {
          if (el.matches && el.matches('a,button,[data-cta],.btn,.cta')) break;
          el = el.parentElement;
        }
        if (!el || el === document.body || !el.matches) return;
        var href = el.getAttribute && el.getAttribute('href');
        var label = (el.getAttribute && el.getAttribute('data-cta')) ||
                    (el.textContent || '').trim().slice(0, 80) || (el.getAttribute && el.getAttribute('aria-label'));
        var isCta = el.matches('[data-cta],.btn,.cta,.nav-cta');
        var type = 'click';
        if (href && /^https?:\/\//.test(href) && href.indexOf(location.host) === -1) type = 'outbound';
        else if (isCta) type = 'cta';
        window.gtTrack(type, label, null, href || null);
      } catch (e) {}
    }

    // 2e. Send the final dwell + scroll for THIS pageview (server keeps the max).
    function sendUpdate() {
      post({ t: 'pv_update', pv_id: pvId, session_id: sid, dwell_ms: currentDwell(), max_scroll_pct: maxScroll });
    }
    function onLeave() {
      if (sentUnload) return; sentUnload = true;
      flush(); sendUpdate();
    }

    document.addEventListener('visibilitychange', onVis, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('click', onClick, true);
    window.addEventListener('pagehide', onLeave, { capture: true });
    window.addEventListener('beforeunload', onLeave, { capture: true });
    setInterval(flush, 15000);
    onScroll(); // capture above-the-fold-only sessions
  } catch (e) { /* analytics must never break a page */ }
})();

// ── 3. META PIXEL (browser PageView; server CAPI owns Lead/Purchase) ───────────────────────────────
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
