// GET /api/menu/public — PUBLIC (no auth) read of the current menu for the marketing /menu page.
// Reads the same D1 weekly_menus table the in-app picker uses, so a menu finalized in the prep dashboard
// shows on the public page automatically (the page previously read the static data/menus.json file, which
// the dashboard never touched). Returns the orderable week's menu; if that week isn't published yet, falls
// back to the most recent published week so the page is never blank between publishes.
import { json } from '../../_lib/respond.js';
import { one } from '../../_lib/db.js';
import { orderableWeek } from '../../_lib/menu.js';

const CACHE = { 'Cache-Control': 'public, max-age=60' }; // fresh within a minute of a finalize

export async function onRequestGet(context) {
  const { env } = context;
  const week = orderableWeek();
  let row = await one(env.DB, `SELECT week_of, label, meals_json FROM weekly_menus WHERE week_of = ?`, week);
  if (!row) row = await one(env.DB, `SELECT week_of, label, meals_json FROM weekly_menus ORDER BY week_of DESC LIMIT 1`);

  if (!row) return json({ has_menu: false, week_of: null, label: null, meals: [] }, 200, CACHE);
  let meals = [];
  try { meals = JSON.parse(row.meals_json); } catch { meals = []; }
  return json({ has_menu: meals.length > 0, week_of: row.week_of, label: row.label, meals }, 200, CACHE);
}
