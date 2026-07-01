-- 0017_weekly_menu_status.sql
-- Owner-confirmation gate for menus. A menu built/"finalized" in the prep dashboard is now STAGED, not
-- instantly live: it only reaches customers after an owner clicks "Confirm & Go Live" (a deliberate weekly
-- human gate, nudged by the Sunday owner reminder). Customer reads (menu/current, menu/public, meals/select)
-- filter status='live'. Existing rows default to 'live' so the current live menu is unaffected. The legacy
-- menus.json cron (publish-menu.js) keeps writing 'live' — only the dashboard path is gated.
ALTER TABLE weekly_menus ADD COLUMN status TEXT NOT NULL DEFAULT 'live';
