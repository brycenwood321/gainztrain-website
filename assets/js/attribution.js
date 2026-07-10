// First-touch marketing attribution capture (GT_MARKETING_PLAN_2026-07-08 §6, Phase 1).
// Included on public entry pages. On land: if the URL carries UTM params / ad click-ids, or the
// visitor arrived from an external referrer, store it ONCE in localStorage (first touch wins —
// a later direct visit never overwrites the ad click that started it). Plain organic direct
// visits store nothing, leaving the slot open for a real first touch. /start reads this at
// signup and sends it to /api/auth/register, which writes the attribution row in D1.
(function () {
  try {
    var KEY = 'gt_attr';
    if (localStorage.getItem(KEY)) return; // first touch already captured
    var q = new URLSearchParams(location.search);
    var a = {};
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid']
      .forEach(function (k) { var v = q.get(k); if (v) a[k] = String(v).slice(0, 120); });
    var ref = document.referrer || '';
    var external = ref && ref.indexOf('//' + location.host) === -1;
    if (!Object.keys(a).length && !external) return; // nothing attributable — don't burn the slot
    a.landing_path = (location.pathname + location.search).slice(0, 300);
    if (external) a.referrer = ref.slice(0, 300);
    a.first_touch_at = new Date().toISOString();
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch (e) { /* attribution must never break a page */ }
})();
