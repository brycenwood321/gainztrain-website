// Cloudflare Pages middleware — runs on every request before reaching pages/functions.
//  (1) blocks internal repo files from being served, (2) gates the legacy billing-mutation endpoints
//  behind the admin token (they were unauthenticated + could mutate any customer's Stripe billing),
//  (3) handles the menu subdomain + www canonical redirects.
import { requireAdmin } from './_lib/admin.js';

// Internal / non-public files in the repo root (the Pages output dir) that must NEVER be served.
// Case-insensitive; matched against BOTH the raw and a normalized path to defeat //, %2f, \, .. tricks.
const BLOCKED_PATHS = [
  /^\/migrations\//i, /^\/cron\//i, /^\/setup\//i,
  /^\/wrangler\.toml$/i, /^\/package(-lock)?\.json$/i, /^\/\.nvmrc$/i,
  /^\/deploy\.md$/i, /^\/ghl-todo\.md$/i, /^\/overnight_build_report[\w-]*\.md$/i,
  /^\/\.dev\.vars$/i, /^\/\.prod-secrets/i, /^\/\.wrangler\//i,
];

// Legacy GHL-funnel endpoints that MUTATE Stripe billing — only ever called server-to-server by GHL,
// never by a browser. Require the admin token so an anonymous attacker can't sabotage a customer's
// billing. (get-subscription + submit-meals are still client-called by the old menu picker, so they're
// handled separately during cutover.)
const ADMIN_ONLY = [
  /^\/api\/assign-delivery-zone\/?$/i,
  /^\/api\/switch-to-pickup\/?$/i,
  /^\/api\/calculate-specialty-upcharge\/?$/i,
];

function normalizePath(pathname) {
  let p = pathname;
  try { p = decodeURIComponent(p); } catch { /* keep raw on bad encoding */ }
  return p.replace(/\\/g, '/').replace(/\/{2,}/g, '/'); // backslashes → slash, collapse repeats
}

export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);
  const norm = normalizePath(url.pathname);
  const hit = (list) => list.some((re) => re.test(url.pathname) || re.test(norm));

  // Never serve internal repo files (schema, config, runbooks) as static assets.
  if (hit(BLOCKED_PATHS)) {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  }

  // Admin-gate the legacy billing-mutation endpoints.
  if (hit(ADMIN_ONLY)) {
    const denied = await requireAdmin(context);
    if (denied) return denied;
  }

  // menu.gainztrainprep.com → the dynamic menu picker page (same site serves both hosts).
  if (url.hostname === 'menu.gainztrainprep.com') {
    const target = new URL('https://gainztrainprep.com/menu-selection/');
    target.search = url.search;
    return Response.redirect(target.toString(), 301);
  }

  // www → apex canonical redirect (SEO best practice)
  if (url.hostname === 'www.gainztrainprep.com') {
    const target = new URL(url);
    target.hostname = 'gainztrainprep.com';
    return Response.redirect(target.toString(), 301);
  }

  return next();
}
