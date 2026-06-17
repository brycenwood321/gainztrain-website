#!/usr/bin/env python3
"""
publish_menu.py — one-shot "update the menu everywhere" for Gainz Train.

The menu lives in TWO places that must stay in sync:
  1. data/menus.json  -> read live by the PUBLIC marketing page (/menu)
  2. D1 weekly_menus   -> read by the APP picker (/app/menu) + meal selection + ops

Editing menus.json only updates the public page. The app reads D1, which historically
only re-synced on the Wednesday 10am MT cron. This script closes that gap: run it any
time you change the menu (e.g. Sunday, dropping next week's menu) and BOTH surfaces update.

What it does:
  - validates every week in menus.json (week_of must be a Sunday; meals non-empty)
  - finds weeks the kitchen has already LOCKED (orders.status='locked') and SKIPS them,
    so a republish can never retroactively change what's being cooked (mirrors the
    /api/admin/publish-menu guard)
  - upserts the remaining weeks into the remote D1 weekly_menus table via wrangler

Auth: uses your local wrangler (already logged into Cloudflare). No admin token needed.
Requires node@22 for wrangler in this repo (see .nvmrc).

Usage:
    python3 scripts/publish_menu.py            # publish to D1
    python3 scripts/publish_menu.py --dry-run  # show what WOULD publish, change nothing

This handles ONLY the D1 side. Commit + push data/menus.json separately to update the
public page (git add data/menus.json && git commit && git push).
"""
import json
import subprocess
import sys
import os
from datetime import datetime, timezone

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MENUS = os.path.join(REPO, "data", "menus.json")
WRANGLER = os.path.join(REPO, "node_modules", ".bin", "wrangler")
DB = "gainztrain"
DRY = "--dry-run" in sys.argv


def wrangler_sql(sql, read_only=False):
    """Run SQL against remote D1. Returns parsed JSON results for SELECTs."""
    cmd = [WRANGLER, "d1", "execute", DB, "--remote", "--json", "--command", sql]
    res = subprocess.run(cmd, capture_output=True, text=True, cwd=REPO)
    if res.returncode != 0:
        sys.exit(f"wrangler failed:\n{res.stderr or res.stdout}")
    # wrangler prints some non-JSON preamble; grab from the first '['
    out = res.stdout
    start = out.find("[")
    return json.loads(out[start:]) if start >= 0 else []


def is_sunday(week_of):
    try:
        return datetime.strptime(week_of, "%Y-%m-%d").weekday() == 6  # Mon=0..Sun=6
    except ValueError:
        return False


def main():
    menus = json.load(open(MENUS))["menus"]

    # Which weeks are locked (kitchen already committed to cooking them)? Never overwrite those.
    locked_rows = wrangler_sql(
        "SELECT DISTINCT week_of FROM orders WHERE status='locked'"
    )
    locked = {r["week_of"] for r in (locked_rows[0]["results"] if locked_rows else [])}

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    statements, published, skipped = [], [], []

    for m in menus:
        wk = m.get("week_of")
        if not (isinstance(wk, str) and is_sunday(wk)):
            skipped.append((wk, "week_of is not a Sunday (YYYY-MM-DD)"))
            continue
        if not isinstance(m.get("meals"), list) or not m["meals"]:
            skipped.append((wk, "meals empty/missing"))
            continue
        if wk in locked:
            skipped.append((wk, "week already locked — menu frozen"))
            continue
        label = (m.get("label") or "").replace("'", "''")
        meals = json.dumps(m["meals"]).replace("'", "''")
        statements.append(
            f"INSERT INTO weekly_menus (week_of,label,meals_json,published_at,created_at,updated_at) "
            f"VALUES ('{wk}','{label}','{meals}','{now}','{now}','{now}') "
            f"ON CONFLICT(week_of) DO UPDATE SET label=excluded.label,meals_json=excluded.meals_json,"
            f"published_at=excluded.published_at,updated_at=excluded.updated_at;"
        )
        published.append((wk, m.get("label"), len(m["meals"])))

    print(f"\nGainz Train menu publish {'(DRY RUN)' if DRY else ''}")
    print("=" * 48)
    for wk, label, n in published:
        print(f"  PUBLISH  {wk}  [{label}]  {n} meals")
    for wk, reason in skipped:
        print(f"  SKIP     {wk}  ({reason})")
    if not published:
        print("  nothing to publish.")
        return

    if DRY:
        print("\nDry run — D1 not changed.")
        return

    sql_path = "/tmp/gt_publish_menu.sql"
    open(sql_path, "w").write("\n".join(statements))
    cmd = [WRANGLER, "d1", "execute", DB, "--remote", f"--file={sql_path}"]
    res = subprocess.run(cmd, capture_output=True, text=True, cwd=REPO)
    if res.returncode != 0:
        sys.exit(f"\npublish FAILED:\n{res.stderr or res.stdout}")
    print(f"\n✅ Published {len(published)} week(s) to D1. App picker + meal selection are live.")


if __name__ == "__main__":
    main()
