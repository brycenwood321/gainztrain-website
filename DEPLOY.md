# Gainz Train D1 revamp — go-live runbook

The D1 backend (auth + account dashboard + Stripe→D1 mirror) is built and tested locally.
These are the steps to make it live. Steps marked **[Brycen]** need a human (auth / dashboard / secrets).

> ⚠️ Do NOT `git push` to `gainztrain-website` until steps 1–4 are done. Pushing triggers a
> Cloudflare Pages production build; the new Functions reference a `DB` (D1) binding that must
> exist remotely first, or the live site's functions will error.

## 0. Tooling (already done)
- Use **node@22**: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"` (node 25 breaks wrangler).
- Wrangler is installed locally: run it as `node_modules/.bin/wrangler …` (or `npm run …`).

## 1. [Brycen] Point wrangler at the right Cloudflare account
`gainztrain-website` Pages lives on the **Risio account** (`1cb0e96b7a8fc02d218dc241ea6732a4`),
NOT the personal account wrangler is currently logged into (`84aba0…`).
- Either `wrangler logout && wrangler login` into the account that owns the Pages project,
- or set `CLOUDFLARE_ACCOUNT_ID=1cb0e96b7a8fc02d218dc241ea6732a4` + a scoped API token in env.
Verify: `node_modules/.bin/wrangler pages project list` shows `gainztrain-website`.

## 2. Create the remote D1 database
```
node_modules/.bin/wrangler d1 create gainztrain
```
Copy the returned `database_id` into `wrangler.toml` (replace `PLACEHOLDER_FILLED_AFTER_REMOTE_CREATE`).

## 3. Apply schema + seed to remote
```
npm run db:migrate:remote      # runs 0001_init.sql + 0002_seed_reference_data.sql
```
Verify zones/zips/coupons:
`node_modules/.bin/wrangler d1 execute gainztrain --remote --command "SELECT count(*) FROM zip_zone_map;"`

## 4. [Brycen] Set production secrets on the Pages project
CF dashboard → Pages → gainztrain-website → Settings → Environment variables (Production), or via CLI
`wrangler pages secret put <NAME> --project-name gainztrain-website`:
- `SESSION_HMAC_SECRET`  — long random string (signs session cookies)
- `STRIPE_SECRET_KEY`    — the **live** sk_live_… key
- `STRIPE_WEBHOOK_SECRET`— from step 6 (the live whsec_…)
- `ADMIN_TOKEN`          — long random string (gates /api/admin/backfill)
- `GAINZ_GHL_TOKEN`      — GT GHL private integration token
- `GAINZ_GHL_LOCATION`   — `tyF96Dl8uAXn5ZD5tZ3p`
- `APP_BASE_URL`         — `https://gainztrainprep.com`
- `SMS_AUTH_ENABLED`     — `false` (flip to `true` only after GT A2P clears)

## 5. Deploy
Bind D1 to the Pages project (dashboard → Settings → Functions → D1 bindings: `DB` → `gainztrain`),
then push to deploy:
```
git add -A && git commit -m "GT D1 revamp: auth + account dashboard + Stripe→D1 mirror" && git push
```
(or `node_modules/.bin/wrangler pages deploy .`)

## 6. [Brycen] Register the Stripe webhook (live mode)
Stripe dashboard → Developers → Webhooks → Add endpoint:
- URL: `https://gainztrainprep.com/api/stripe-webhook`
- Events: `customer.subscription.*`, `invoice.*`, `payment_intent.succeeded`,
  `payment_intent.payment_failed`, `charge.refunded`, `customer.created/updated`
- Copy the signing secret (`whsec_…`) → set as `STRIPE_WEBHOOK_SECRET` (step 4) → redeploy.

## 7. Backfill existing live customers into D1 (run once)
```
curl -X POST "https://gainztrainprep.com/api/admin/backfill?dry=1" -H "X-Admin-Token: $ADMIN_TOKEN"   # preview counts
curl -X POST "https://gainztrainprep.com/api/admin/backfill"        -H "X-Admin-Token: $ADMIN_TOKEN"   # real import
```
Re-runnable (every op is an upsert). After this, D1 holds the 5 live subs + their invoices.

## 8. Verify live
- `https://gainztrainprep.com/app/` loads the login screen.
- Log in (magic link works once `GAINZ_GHL_TOKEN` is set so the email sends).
- `/api/me` returns the account with the backfilled subscription/invoice data.

## Notification system + ops back end deploy (2026-06-07) — built + tested, NOT yet live

Notification Steps 0-7 (confirmations, billing off the webhook, weekly cycle, in-app feed, preferences,
delivery tracker) + Phase 4 ops back end (overview/kitchen/route/customers dashboard) are built and
locally tested (29 templates + idempotency/prefs/regression suites + all SQL validated vs real SQLite).
To make it live:

1. **Apply migrations 0007-0011** (idempotency guard, in-app feed table, prefs table, delivery tracker
   columns, frozen order delivery_method): `npm run db:migrate:remote`
2. **Confirm prod secrets** (step 4): `GAINZ_GHL_TOKEN` (emails send), `APP_BASE_URL=https://gainztrainprep.com`,
   `SESSION_HMAC_SECRET` (REQUIRED — marketing email now fail-closes without it), `ADMIN_TOKEN`
   (gates the ops dashboard + cron), `SMS_AUTH_ENABLED=false` (keep false until A2P clears).
3. **Deploy the Pages project** (`git push` or `wrangler pages deploy .`).
4. **Re-deploy the cron Worker** (`cd cron && wrangler deploy`) — now Wed reminders, Fri last-call,
   Sat lock, Sun feed-prune.
5. **[Brycen] Add two Stripe webhook events** (Step 3 emails can't fire until subscribed):
   `invoice.upcoming` + `customer.source.expiring`. Also confirm the Smart Retries setting (drives the
   "your plan is paused" final email off subscription.status=unpaid).
6. **Smoke test:** change something in `/app` (e.g. pause) → email arrives + `comms_log` row `ghl_status='sent'`
   + an in-app feed row appears in the bell. Fire a webhook test event → exactly ONE receipt row.

**Surfaces:** customer app `/app/` (now has the notification bell) · `/app/manage/` (notification
prefs card) · `/app/track/?t=<token>` (public delivery tracker) · `/app/ops/` (token-gated ops dashboard
— enter the ADMIN_TOKEN). Announce a new menu with `POST /api/admin/publish-menu?notify=1` (plain call
stays a silent sync). Advance deliveries from the Ops → Route tab or
`POST /api/admin/delivery-status?status=out_for_delivery`. SMS is written everywhere but gated on
`SMS_AUTH_ENABLED` — flip to `true` only after A2P, money/surprise events first.

## Still on the roadmap (after go-live)
- Migrate the existing `/api/*` functions (assign-delivery-zone, submit-meals, calculate-specialty-upcharge,
  switch-to-pickup) to read/write D1 as the source of truth instead of scanning Stripe/GHL at runtime.
- `gt_health.py`-style daily probe (comms_log + stripe_events `processed_at IS NULL` = the leak detector).
