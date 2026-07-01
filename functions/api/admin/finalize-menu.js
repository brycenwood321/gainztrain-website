// POST /api/admin/finalize-menu — publish a menu BUILT IN THE PREP DASHBOARD (Marissa's Menu tab) into
// the live weekly_menus D1 table so customers can order it. This is the dashboard-driven twin of
// publish-menu.js (which syncs from data/menus.json). A week finalized here is marked source='dashboard'
// so the Wednesday cron publish (from menus.json) will NOT overwrite it (see publish-menu.js guard).
//
// AUTH: requireStaffOrAdmin — Brycen/Jayson hit "Finalize" while logged in as staff (session cookie),
// or the admin token works for server-side runs.
//
// CUSTOMER "NEW MENU DROPPED" BLAST: built but GATED OFF. It only fires when env.MENU_BLAST_ENABLED ===
// 'true' (set that ONE env var once A2P SMS + email deliverability are fixed, and it auto-activates — no
// rebuild). Until then Finalize publishes silently: the menu goes live + orderable, no customer message.
//
// BODY: { meals: [ { name, macros:{protein,carbs,fat,cal?}, description?, image?, emoji?, upcharge_per_meal? } ],
//         week_of?: "YYYY-MM-DD" }
// Target week defaults to the server's orderableWeek() (the week customers can order right now). A
// client week_of is honored only if it's a future, unlocked Sunday.
import { ok, fail } from '../../_lib/respond.js';
import { requireStaffOrAdmin } from '../../_lib/admin.js';
import { one, run, nowIso } from '../../_lib/db.js';
import { orderableWeek } from '../../_lib/menu.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isSunday(iso) {
  return DATE_RE.test(iso) && new Date(`${iso}T12:00:00Z`).getUTCDay() === 0;
}
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

// One dashboard meal → the canonical weekly_menus meal shape the customer picker + ops + lock-week read.
// Marissa's Menu tab supplies name + macros (and ingredients, which are kitchen-only and not needed here);
// the marketing/billing fields are defaulted so the customer picker renders identically to a menus.json menu.
function normalizeMeal(m, i) {
  const macros = (m && m.macros) || {};
  const protein = Math.round(Number(macros.protein) || 0);
  const carbs = Math.round(Number(macros.carbs) || 0);
  const fat = Math.round(Number(macros.fat) || 0);
  const calories = Math.round(Number(macros.cal) || (protein * 4 + carbs * 4 + fat * 9)); // derive if absent
  return {
    position: i + 1,
    name: String((m && m.name) || `Meal ${i + 1}`).slice(0, 120),
    description: String((m && m.description) || '').slice(0, 400),
    calories, protein, carbs, fat,
    image: String((m && m.image) || ''),        // empty → the picker falls back to the emoji
    emoji: String((m && m.emoji) || '🍱'),
    upcharge_per_meal: Number(m && m.upcharge_per_meal) || 0, // no upcharge UI in the dashboard yet → standard
    slug: slugify((m && m.slug) || (m && m.name)),
  };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const denied = await requireStaffOrAdmin(context);
  if (denied) return denied;

  let body;
  try { body = await request.json(); } catch { return fail(400, 'bad_json', 'Body must be JSON.'); }
  const rawMeals = Array.isArray(body.meals) ? body.meals : null;
  if (!rawMeals || rawMeals.length === 0) return fail(400, 'no_meals', 'Send at least one meal.');

  // Target week: the orderable week by default. Honor a client week_of only if it's a future, unlocked Sunday.
  let week = orderableWeek();
  if (body.week_of && isSunday(body.week_of) && body.week_of >= week) {
    const lk = await one(env.DB, `SELECT 1 AS x FROM orders WHERE week_of = ? AND status = 'locked' LIMIT 1`, body.week_of);
    if (!lk) week = body.week_of;
  }

  // Never overwrite a week the kitchen has already locked — that menu is frozen (they're cooking it).
  const locked = await one(env.DB, `SELECT 1 AS x FROM orders WHERE week_of = ? AND status = 'locked' LIMIT 1`, week);
  if (locked) return fail(409, 'week_locked', `Week of ${week} is already locked for the kitchen — its menu is frozen.`);

  const meals = rawMeals.map(normalizeMeal);
  const now = nowIso();

  // OWNER-CONFIRMATION GATE: finalizing STAGES the menu — it does NOT go live to customers until an owner
  // hits "Confirm & Go Live" (/api/admin/confirm-menu). Exception: editing a week that's ALREADY live keeps
  // it live (quick fixes shouldn't yank the menu out from under customers mid-week). The customer "new menu
  // dropped" blast fires at go-live (in confirm-menu.js), not here.
  const existing = await one(env.DB, `SELECT status FROM weekly_menus WHERE week_of = ?`, week);
  const status = existing && existing.status === 'live' ? 'live' : 'staged';

  await run(env.DB,
    `INSERT INTO weekly_menus (week_of, label, meals_json, published_at, created_at, updated_at, source, status)
     VALUES (?, 'This Week', ?, ?, ?, ?, 'dashboard', ?)
     ON CONFLICT(week_of) DO UPDATE SET meals_json=excluded.meals_json, label=excluded.label,
       published_at=excluded.published_at, updated_at=excluded.updated_at, source='dashboard', status=excluded.status`,
    week, JSON.stringify(meals), now, now, now, status);

  return ok({
    week_of: week,
    meals: meals.length,
    source: 'dashboard',
    status,
    live: status === 'live',
    note: status === 'live'
      ? 'Updated the live menu (this week was already live).'
      : 'Menu STAGED — it is not visible to customers until an owner hits "Confirm & Go Live".',
  });
}
