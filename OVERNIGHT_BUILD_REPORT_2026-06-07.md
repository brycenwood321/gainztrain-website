# GT Overnight Build Report — night of 2026-06-07 (Sat→Sun)

Brycen went to bed and asked me to build out as much of the GT app as I can without going live, running
an adversarial bug-hunt after each step and fixing what it finds. This is the running log. Nothing was
deployed. All work is on disk + locally tested in the `gainztrain-website` repo.

## ☀️ MORNING SUMMARY (read this first)

I finished **everything** you asked for and it's all tested. Nothing went live.

**Built tonight (Steps 5, 6, 7 + Phase 4):**
1. **In-app notification feed** — a bell + dropdown in `/app` so customers see every notification *inside*
   the app, not just email (survives spam folders).
2. **Notification preferences** — customers can opt out of non-essential emails; one-click unsubscribe on
   marketing; receipts/payment/order emails always send.
3. **Delivery tracker** — a live DoorDash-style status page (`/app/track`) + an ops control to advance
   "prepping → out for delivery → delivered" that texts/emails the customer at each step.
4. **Ops back end** (`/app/ops`) — a token-gated dashboard: kitchen prep list (what Jayson cooks),
   delivery route by zone, business overview (active subs, revenue, health), and a customer/billing view.

**Quality process (your adversarial bug-hunt model):** ran a multi-agent hunt after each chunk.
- Steps 5-7 hunt: 18 findings (0 high/critical) → all fixed.
- Phase 4 hunt: 14 findings (1 high: refunds weren't netted into revenue) → all fixed.
- Plus I validated every migration + query against a real SQLite engine since I can't deploy.

**5 new migrations (0007-0011)**, ~20 new/changed endpoints, 4 app pages, 33 notification templates.
All on disk, **not committed, not deployed** (per "save until we deploy").

**What still needs YOU (unchanged from before):**
1. Cloudflare **Risio** account access (scoped API token) → then I run migrations + deploy.
2. Verify Stripe **Smart Retries** + subscribe `invoice.upcoming` + `customer.source.expiring`.
3. The **pause/resume mid-week** billing rule (your call w/ Jayson, Marissa, Alyssa).

Full play-by-play below. Deploy steps in `DEPLOY.md`.

---

## Status at start of night
- Notification phase Steps 0-4 + Step 3 built, bug-hunted (35-agent workflow, 14 findings all fixed),
  25 templates passing render/idempotency/regression tests.
- Deploy blocked on Cloudflare Risio account access (Brycen to provide a scoped token).

## Plan for the night
1. Step 5 — in-app notification feed (table done; + notify hook + API + bell UI in /app)
2. Step 6 — notification preferences / opt-outs
3. Step 7 — delivery tracker (status lifecycle + public tracker page + notifications)
4. Phase 4 — ops back end (kitchen prep list, admin dashboard, billing view, delivery route map)
5. Bug-hunt + fix after each.

---

## Progress log

### ✅ Step 5 — In-app notification feed (DONE)
- `migrations/0008_notifications_feed.sql` — `notifications` table (display feed; idempotency still on comms_log).
- `functions/_lib/notify.js` — every successful send now also drops a feed row (category + deep link
  derived from the event; body = the SMS one-liner with URLs stripped). Skipped on dedup / released-failure
  so each logical notification = at most one feed row.
- `functions/api/notifications.js` (GET, list + unread count) and `functions/api/notifications/read.js`
  (POST, mark one/all read), both session-scoped so a customer can't touch another's rows.
- `app/index.html` — bell + unread badge + dropdown feed in the topbar; opening clears the badge
  (marks read server-side) but keeps the highlight so you can see what's new; outside-click closes.
- Tests: syntax OK, HTML tag balance OK, full notify suite (25 templates) still green.

### ✅ Step 6 — Notification preferences + opt-outs (DONE)
- `migrations/0009_notification_prefs.sql` — `notification_prefs` (email_account, email_marketing,
  sms_account, sms_marketing; sms_marketing default OFF for TCPA).
- `functions/_lib/notify.js` — `PREF_CLASS` map. Critical (receipts, payment alerts, refunds, password,
  order confirmations/locks) ALWAYS send. account/marketing respect opt-outs. Marketing email gets a
  one-click HMAC unsubscribe footer. Opted-out customers still get the in-app feed row (only email/SMS
  suppressed) and skip the GHL contact lookup entirely.
- `functions/api/account/notification-prefs.js` (GET/POST, merge-on-partial) + `functions/api/unsubscribe.js`
  (GET, HMAC-signed, no login, flips email_marketing off, branded confirmation page).
- `app/manage/index.html` — a Notifications card with 3 toggles; loads + saves prefs.
- Tests: a dedicated prefs-gating suite proves opt-out suppresses marketing email, account still sends,
  CRITICAL ignores all opt-outs, no-row = defaults on, and the in-app feed always records. All green.

### ✅ Step 7 — Delivery tracker (DONE)
- `migrations/0010_delivery_tracker.sql` — orders gain delivery_status / delivery_eta / delivered_at /
  tracking_token (+ index); customers gain lat/lng for the future route map.
- 4 new templates: order_prepped, order_out_for_delivery (with live track link), order_delivered,
  order_pickup_ready.
- `functions/api/admin/delivery-status.js` — admin/driver advances the lifecycle for a week's locked
  orders (prepping → out_for_delivery → delivered for delivery; → pickup_ready → picked_up for pickup),
  mints a tracking token, and notifies the right subset (deduped per status+order).
- `functions/api/track.js` — public, token-gated, non-PII status for the tracker page.
- `app/track/index.html` — DoorDash-style vertical stepper (confirmed → prepped → on the way →
  delivered, pulsing current step), reads ?t= token, branches delivery vs pickup flow.
- Tests: syntax OK, page tag balance OK, 29-template suite green.

### ✅ Phase 4 — Ops back end (DONE)
- `functions/api/admin/overview.js` — dashboard stats: active subs + status mix, this-week locked
  production (orders/meals/upcharge), delivery/pickup split, weekly recurring meal revenue, 30-day paid
  revenue, and two health signals (failed comms 24h, stuck/unprocessed Stripe events).
- `functions/api/admin/kitchen-prep.js` — the cook list: total quantity per meal across all locked
  orders for the week (what Jayson makes), + headcount.
- `functions/api/admin/route.js` — the delivery run: locked delivery orders grouped by zone with
  address + per-stop meal count + live delivery status (the "delivery location map" source).
- `functions/api/admin/customers.js` — customer list (status + lifetime spend) and ?id= billing view
  (subscriptions + invoices + payments).
- `app/ops/index.html` — token-gated ops dashboard (localStorage), tabs: Overview / Kitchen prep /
  Route / Customers, with one-click delivery-status advance buttons (mark prepping / out for delivery /
  delivered / pickups ready) that fire the customer tracker notifications.
- Tests: all 4 endpoints syntax OK; ops page tag balance + template-literal balance OK.

### Bug hunts
- Steps 0-4 hunt: 14 findings, all fixed (earlier).
- Steps 0-4 hunt: 14 findings, all fixed.
- **Steps 5-7 hunt: 18 confirmed (0 critical/high, 3 medium, 15 low). ALL FIXED.** Verdict was
  "ship after the 2 must-fixes; core security invariants all hold (128-bit track token, no IDOR,
  unforgeable unsubscribe HMAC, idempotent feed insert, critical never suppressed)." Fixes:
  - MUST: dropped first_name PII leak from public /api/track (+ generic tracker title); guarded
    null/primitive JSON bodies in notification-prefs + read (400 not 500).
  - Delivery state machine hardened: forward-only rank guard (no regress / no re-notify "on the way"
    for delivered orders); delivered_at made WRITE-ONCE (COALESCE arg flip); FROZEN per-order
    delivery_method (migration 0011 + lock-week snapshot + delivery-status/route/track consume it) so a
    post-lock pickup↔delivery switch can't mis-target; address.js made lock-aware like tier.js;
    tracker page handles unknown status without collapsing to step 0; ETA now actually wired
    (?eta= param → stored + shown).
  - notify.js fail-closed: unmapped event → 'critical' (never silently opt-out-able) + audit log;
    marketing email with no buildable unsubscribe footer is SUPPRESSED (CAN-SPAM) + audit log.
  - Polish: single SMS toggle now covers account+marketing; bell-open refreshes the feed; unsubscribe
    "expired" copy fixed; notifications-table prune endpoint + Sunday cron; picked_up documented as
    intentionally silent.
  - All re-validated: 29 templates + prefs(incl. new fail-closed cases) + regression suites green;
    migration 0011 + frozen-method + write-once delivered_at confirmed against real SQLite.
- **Phase 4 ops hunt: 14 confirmed (1 high, 1 medium, 12 low). ALL FIXED.** Verdict "ship after the one
  must-fix; internal token-gated tool, well-built." Fixes:
  - MUST (high): refunds weren't netted → dashboard + lifetime-spend overstated revenue. Now NET of
    refunds (paid invoices + negative refund payments) in overview.js + customers.js. Validated: a $20
    refund correctly drops net rev 16755→14755 and c1 spend 11400→9400.
  - MEDIUM: weekly recurring counted past_due + ignored coupons → renamed to "weekly list price"
    (pre-discount), computed over the billing set (active+trialing only), labeled honestly in the UI.
  - Hardening: centralized admin auth into `_lib/admin.js` with a CONSTANT-TIME hashed compare, applied
    to ALL 11 admin endpoints (kills the copy-pasted non-constant-time `!==` + drift risk); delivery_split
    now COUNT(DISTINCT customer); delivery-status validates week_of is a real Sunday (can't mass-advance a
    garbage week); ops UI escapes status values in class attributes (+ single-quote in esc map) and clears
    the token on a 401.

### ✅ Final verification (whole codebase)
- All 59 Pages-Function files syntax-OK (ESM parse).
- All 11 migrations apply clean on a fresh SQLite DB, in order.
- All 4 app pages (app, manage, track, ops) tag-balanced.
- All 4 notification test suites green (templates, idempotency, preference-gating, regression, Step 4).
- Every new/changed SQL query validated against real SQLite with seeded data (aggregation, idempotency,
  NULL handling, COALESCE write-once, refund netting).

### Not committed
Per "save until we deploy," nothing is git-committed and nothing is deployed. All work is on disk in the
`gainztrain-website` repo, ready to commit + deploy via DEPLOY.md when you've got the Cloudflare Risio access.

### ✅ SQL validation against real SQLite (all 10 migrations + every new query)
Since I can't deploy, I applied migrations 0001-0010 to a throwaway SQLite DB, seeded sample data, and
ran every new query. All correct:
- Migrations 0001-0010 apply cleanly in order.
- Kitchen prep: Chicken Bowl 13 (7+6), Beef 5 — JOIN does NOT double-count. Weekly recurring = 17700
  (12×950 + 6×1050). Route correctly excludes the pickup customer. Customer spend correct.
- Dedup claim returns changes=1 then 0 (idempotency holds at the DB layer); two NULL dedup_keys both
  insert (unique index treats NULLs as distinct — the existing/simple sends never collide).
- notification_prefs partial upsert keeps email_account=1 (default) while setting email_marketing=0.
- delivery-status UPDATE: tracking_token STAYS across a re-advance (COALESCE), delivered_at sets on
  'delivered'. Public track query returns minimal non-PII fields.

(updated as I go)
