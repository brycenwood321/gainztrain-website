// /api/admin/meta-spend-sync — pull per-ad daily spend from Meta into `marketing_spend`, then audit
// the registry for drift. Cron-driven (gainztrain-cron hits this daily at 13:00 UTC).
//
// WHY THIS EXISTS AS AN ENDPOINT: CAC per offer/hook/audience is only computable if spend is keyed to
// the same ad_id the visitor carried in. The hand-logged /api/admin/spend form is per-channel and
// cannot do that. This was a local Python script (gainz-train/scripts/meta_spend_sync.py) which meant
// the cost half of the marketing dashboard only updated when someone remembered to run it on a laptop.
// The funnel half updates itself, so the two silently drifted apart and every CAC number went stale.
//
// IDEMPOTENT: upserts on (day, ad_id) via the partial unique index uq_spend_day_ad, so re-running is
// safe and Meta's retroactive spend revisions settle rather than double-counting. That is also why it
// re-pulls a 30-day window every night instead of only yesterday — Meta revises spend after the fact.
//
// ⚠️ The ON CONFLICT target MUST repeat the partial index's WHERE clause. Without
// `WHERE ad_id IS NOT NULL`, SQLite cannot match the statement to uq_spend_day_ad and the whole
// insert fails.
//
// TOKEN: META_ADS_TOKEN must be the `ads_read` system-user token (the "marketing_api" block in
// _config/meta_ads.json). The CAPI token CANNOT read insights — it returns error 200. This token
// cannot spend or edit anything.
//
// ENV-GATED: with no META_ADS_TOKEN set this no-ops with skipped:true rather than failing, so the
// cron does not spew errors before the variable is configured.
import { ok, fail } from '../../_lib/respond.js';
import { requireAdmin } from '../../_lib/admin.js';
import { all, batch, nowIso } from '../../_lib/db.js';
import { ownerNotify } from '../../_lib/owner_notify.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

// Meta revises spend retroactively, so re-pull a window rather than just yesterday.
const DEFAULT_PRESET = 'last_30d';
const ALLOWED_PRESETS = new Set(['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d', 'last_90d', 'maximum']);

async function graph(path, token, params = {}) {
  const qs = new URLSearchParams({ ...params, access_token: token });
  const r = await fetch(`${GRAPH}/${path}?${qs}`, { headers: { accept: 'application/json' } });
  const d = await r.json().catch(() => ({}));
  if (d.error) throw new Error(`Meta API: ${d.error.message || 'unknown error'}`);
  if (!r.ok) throw new Error(`Meta API HTTP ${r.status}`);
  return d;
}

/** Pull every page of a Graph edge. One ad today, but a paging cap that silently truncates spend
 *  would understate CAC forever and never announce itself. */
async function graphAll(path, token, params, maxPages = 10) {
  const out = [];
  let page = await graph(path, token, params);
  out.push(...(page.data || []));
  for (let i = 1; i < maxPages && page.paging && page.paging.next; i++) {
    const r = await fetch(page.paging.next, { headers: { accept: 'application/json' } });
    page = await r.json().catch(() => ({}));
    if (page.error) throw new Error(`Meta API: ${page.error.message}`);
    out.push(...(page.data || []));
  }
  return out;
}

async function syncSpend(env, db, token, act, preset) {
  const rows = await graphAll(`${act}/insights`, token, {
    level: 'ad',
    date_preset: preset,
    time_increment: '1',
    fields: 'ad_id,ad_name,campaign_name,spend,impressions,inline_link_clicks',
    limit: '500',
  });

  const stmts = [];
  let totalCents = 0;
  for (const r of rows) {
    const spendCents = Math.round(Number(r.spend || 0) * 100);
    if (!r.ad_id || !r.date_start) continue;
    totalCents += spendCents;
    stmts.push(db.prepare(
      `INSERT INTO marketing_spend (day, channel, campaign, ad_id, ad_name, spend_cents, impressions, link_clicks, created_at)
       VALUES (?, 'meta', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day, ad_id) WHERE ad_id IS NOT NULL DO UPDATE SET
         spend_cents = excluded.spend_cents,
         impressions = excluded.impressions,
         link_clicks = excluded.link_clicks,
         campaign    = excluded.campaign,
         ad_name     = excluded.ad_name`
    ).bind(
      r.date_start, r.campaign_name || null, r.ad_id, r.ad_name || null,
      spendCents, Number(r.impressions || 0), Number(r.inline_link_clicks || 0), nowIso()
    ));
  }

  // Chunked so one oversized batch can't blow the subrequest budget.
  for (let i = 0; i < stmts.length; i += 40) await batch(db, stmts.slice(i, i + 40));

  return { ad_days: stmts.length, spend_usd: Math.round(totalCents) / 100, preset };
}

/** Compare each live ad's url_tags against its marketing_variants row. An ad that gets silently
 *  retagged (or a registry row nobody updated) corrupts weeks of attribution with no error anywhere.
 *  This is the tripwire — it is the reason the job alerts instead of just writing numbers. */
async function auditDrift(db, token, act) {
  const ads = await graphAll(`${act}/ads`, token, {
    fields: 'id,name,effective_status,creative{url_tags}',
    limit: '200',
  });
  const regRows = await all(db, `SELECT key, ad_name, offer, landing_variant, status FROM marketing_variants`);
  const reg = new Map(regRows.map((r) => [r.key, r]));

  const findings = [];
  const seen = new Set();
  for (const a of ads) {
    seen.add(a.id);
    const tags = (a.creative && a.creative.url_tags) || '';
    const parsed = Object.fromEntries(new URLSearchParams(tags));
    const row = reg.get(a.id);
    const issues = [];

    if (!row) {
      issues.push('not in registry — its traffic cannot be sliced by hook/audience');
    } else {
      if (row.landing_variant && parsed.v && parsed.v !== row.landing_variant) {
        issues.push(`offer mismatch: ad sends v=${parsed.v}, registry says ${row.landing_variant}`);
      }
      if (row.ad_name && row.ad_name !== a.name) {
        issues.push(`renamed in Meta: "${a.name}" vs registry "${row.ad_name}"`);
      }
    }
    if (!tags.includes('{{ad.id}}') && !tags.includes('ad_id=')) {
      issues.push('url_tags missing ad_id — clicks land unattributable');
    }
    if (!tags.includes('{{placement}}') && !tags.includes('utm_term=')) {
      issues.push('url_tags missing placement');
    }
    if (issues.length) findings.push({ ad_id: a.id, ad_name: a.name, status: a.effective_status, issues });
  }

  for (const [key, row] of reg) {
    if (row.status === 'live' && !seen.has(key)) {
      findings.push({ ad_id: key, ad_name: row.ad_name, status: 'missing',
        issues: ['registry row is marked live but no such ad exists in Meta'] });
    }
  }

  return { ads_checked: ads.length, registry_rows: reg.size, findings };
}

async function handle(context) {
  const denied = await requireAdmin(context);
  if (denied) return denied;

  const { env } = context;
  const token = env.META_ADS_TOKEN;
  const act = env.META_AD_ACCOUNT;
  if (!token || !act) {
    return ok({ skipped: true, reason: 'META_ADS_TOKEN / META_AD_ACCOUNT not set — spend sync is inactive' });
  }

  const url = new URL(context.request.url);
  const auditOnly = url.searchParams.get('audit_only') === '1';
  const preset = url.searchParams.get('preset') || DEFAULT_PRESET;
  if (!ALLOWED_PRESETS.has(preset)) {
    return fail(400, 'bad_preset', `preset must be one of: ${[...ALLOWED_PRESETS].join(', ')}`);
  }

  const db = env.DB;
  const out = { ok: true, audit_only: auditOnly };

  try {
    if (!auditOnly) out.spend = await syncSpend(env, db, token, act, preset);
    out.drift = await auditDrift(db, token, act);
  } catch (e) {
    // A dead token or a Meta outage must be loud. Silent failure here means the dashboard keeps
    // showing yesterday's cost as if it were current, which is worse than showing nothing.
    const msg = String(e && e.message ? e.message : e).slice(0, 300);
    console.error(`[meta-spend-sync] FAILED: ${msg}`);
    await ownerNotify(env, 'marketing_spend_sync_failed', `Meta spend sync failed: ${msg}`, { error: msg });
    return fail(502, 'meta_sync_failed', msg);
  }

  if (out.drift.findings.length) {
    const lines = out.drift.findings
      .map((f) => `${f.ad_name || f.ad_id} [${f.status}]: ${f.issues.join('; ')}`)
      .join('\n');
    await ownerNotify(env, `marketing_drift:${new Date().toISOString().slice(0, 10)}`,
      `Marketing registry drift on ${out.drift.findings.length} ad(s)`, { detail: lines });
  }

  return ok(out);
}

export const onRequestPost = handle;
export const onRequestGet = handle;
