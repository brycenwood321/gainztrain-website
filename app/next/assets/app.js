// Gainz Train customer app shell: the few helpers every /app/next page shares. Classic script.
window.GT = (function () {
  const api = (path, opts = {}) => fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });
  const money = (cents) => '$' + ((cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money0 = (cents) => '$' + Math.round((cents || 0) / 100).toLocaleString('en-US');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const $ = (id) => document.getElementById(id);

  let toastTimer = null;
  function toast(text) {
    let el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = text; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  // Bottom tab bar. ONE definition; each page passes which tab it is. Invite lands in slice two.
  const TABS = [
    { key: 'home', label: 'Home', ic: '🏠', href: '/app/next/' },
    { key: 'meals', label: 'Meals', ic: '🍽️', href: '/app/menu/' },
    { key: 'account', label: 'Account', ic: '👤', href: '/app/manage/' },
  ];
  function tabbar(active) {
    const el = document.createElement('nav');
    el.className = 'tabbar'; el.setAttribute('aria-label', 'Main');
    el.innerHTML = TABS.map((t) => `<a href="${t.href}" class="${t.key === active ? 'active' : ''}" aria-current="${t.key === active ? 'page' : 'false'}"><span class="ic" aria-hidden="true">${t.ic}</span>${t.label}</a>`).join('');
    document.body.appendChild(el);
  }

  return { api, post, money, money0, esc, $, toast, tabbar, TABS };
})();
