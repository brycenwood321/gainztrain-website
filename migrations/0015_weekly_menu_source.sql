-- 0015_weekly_menu_source.sql
-- Marks WHERE a weekly_menus row came from:
--   source='dashboard'  → finalized from the prep dashboard (Marissa's Menu tab → /api/admin/finalize-menu)
--   source=NULL         → synced from data/menus.json (publish-menu.js / the Wednesday cron)
-- The Wednesday cron publish (from menus.json) SKIPS any week with source='dashboard', so a menu the
-- staff set + published from the dashboard can never be silently clobbered by the file-based sync.
ALTER TABLE weekly_menus ADD COLUMN source TEXT;
