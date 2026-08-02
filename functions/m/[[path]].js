// GET /m/<mealId> — public "meal macros" page. Meal-label QR codes now encode THIS url, so the sticker
// does double duty:
//   • the kitchen's Assembly scanner pulls the mealId back out of the url (unchanged workflow), and
//   • a CUSTOMER who scans the sticker lands here and sees their meal's macros — not a raw code.
// Shows ONLY meal nutrition (name + macros). No customer name/address/PII, so scanning any label is safe.
//
// The mealId is GT-<YYYYMMDD>-<customerId>-<slug>-<n>. We take the week (parts[1]) + the slug
// (second-to-last part — robust even when customerId contains hyphens, e.g. "manual-<ts>"), then look the
// meal up in that week's published menu (weekly_menus) by re-deriving the same 12-char slug from each name.
import { one } from '../_lib/db.js';

function mealSlug(name) {
  return String(name || 'meal').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'meal';
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const STYLE = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#fafaf8;color:#1a1614;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:28px 18px}
  .brand{font-family:'Barlow Condensed',Impact,sans-serif;font-weight:900;font-size:1.5rem;letter-spacing:.08em;text-transform:uppercase;margin-bottom:18px}
  .brand span{color:#ff6b35}
  .card{background:#fff;border:1px solid #ececec;border-radius:18px;width:100%;max-width:400px;padding:26px 22px;text-align:center;box-shadow:0 8px 30px rgba(26,22,20,.06)}
  .emoji{font-size:3rem;line-height:1;margin-bottom:6px}
  h1{font-family:'Barlow Condensed',Impact,sans-serif;font-weight:800;font-size:1.7rem;letter-spacing:.01em;text-transform:uppercase;line-height:1.05;margin-bottom:8px}
  .desc{color:#6b6b6b;font-size:.92rem;line-height:1.45;margin-bottom:18px}
  .cals{font-family:'Barlow Condensed',Impact,sans-serif;font-weight:900;font-size:3.2rem;line-height:1;color:#ff6b35;margin:6px 0 2px}
  .cals span{font-size:1rem;color:#9a908c;font-weight:700;margin-left:4px}
  .cals-label{font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;color:#9a908c;font-weight:700;margin-bottom:20px}
  .macros{display:flex;gap:10px;margin-bottom:20px}
  .macro{flex:1;background:#faf7f4;border:1px solid #f0ece8;border-radius:12px;padding:14px 6px}
  .macro b{display:block;font-family:'Barlow Condensed',Impact,sans-serif;font-size:1.6rem;font-weight:900;color:#1a1614;line-height:1}
  .macro span{font-size:.66rem;letter-spacing:.1em;text-transform:uppercase;color:#9a908c;font-weight:700}
  .log{font-size:.9rem;color:#4a4440;background:#fff3ee;border-radius:10px;padding:10px 12px;margin-bottom:18px}
  .btn{display:block;background:#ff6b35;color:#fff;text-decoration:none;font-weight:800;padding:13px;border-radius:11px;letter-spacing:.02em}
  .muted{color:#9a908c;font-size:.95rem;line-height:1.5;margin-bottom:18px}
  .foot{color:#c3bab5;font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;font-weight:700;margin-top:20px}
  @media (prefers-color-scheme: dark){
    body{background:#131110;color:#f3efec}.card{background:#1e1a18;border-color:#2b2623;box-shadow:none}
    .macro{background:#161311;border-color:#2b2623}.macro b{color:#f3efec}.desc{color:#a89f99}.log{background:#2a1c14;color:#f0d9cc}
  }`;

function pageHtml(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · Gainz Train</title>
<style>${STYLE}</style></head><body>${bodyHtml}<p class="foot">Fuel Your Engine · Gainz Train</p></body></html>`;
}

export async function onRequestGet(context) {
  const { params, env } = context;
  const raw = Array.isArray(params.path) ? params.path.join('/') : String(params.path || '');
  const mealId = decodeURIComponent(raw).trim();
  const parts = mealId.split('-');
  const week = parts[1] || '';
  const slug = parts.length >= 4 ? parts[parts.length - 2] : '';

  let meal = null;
  if (/^\d{8}$/.test(week) && slug) {
    const weekOf = `${week.slice(0, 4)}-${week.slice(4, 6)}-${week.slice(6, 8)}`;
    try {
      const row = await one(env.DB, `SELECT meals_json FROM weekly_menus WHERE week_of = ?`, weekOf);
      if (row && row.meals_json) {
        const meals = JSON.parse(row.meals_json);
        meal = meals.find((m) => mealSlug(m.name) === slug) || null;
      }
    } catch { /* fall through to not-found */ }
  }

  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' };

  if (!meal) {
    const body = `<div class="brand">GAINZ<span>TRAIN</span></div>
      <div class="card"><div class="emoji">🍱</div><h1>Meal Details</h1>
      <p class="muted">We couldn't pull this meal's macros — it may be from a past week. Check out what's cooking this week:</p>
      <a class="btn" href="https://gainztrainprep.com/menu/">See this week's menu →</a></div>`;
    return new Response(pageHtml('Meal', body), { headers });
  }

  const cals = Math.round(meal.calories || (meal.protein * 4 + meal.carbs * 4 + meal.fat * 9));
  const body = `<div class="brand">GAINZ<span>TRAIN</span></div>
    <div class="card">
      <div class="emoji">${esc(meal.emoji || '🍱')}</div>
      <h1>${esc(meal.name)}</h1>
      ${meal.description ? `<p class="desc">${esc(meal.description)}</p>` : ''}
      <div class="cals">${cals}<span>cal</span></div>
      <div class="cals-label">per meal</div>
      <div class="macros">
        <div class="macro"><b>${Math.round(meal.protein) || 0}g</b><span>Protein</span></div>
        <div class="macro"><b>${Math.round(meal.carbs) || 0}g</b><span>Carbs</span></div>
        <div class="macro"><b>${Math.round(meal.fat) || 0}g</b><span>Fat</span></div>
      </div>
      <p class="log">📲 Log these numbers in your fitness app to track your day.</p>
      <a class="btn" href="https://gainztrainprep.com/menu/">See this week's menu →</a>
    </div>`;
  return new Response(pageHtml(meal.name, body), { headers });
}
