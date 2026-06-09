// Cloudflare Pages middleware — runs on every request before reaching pages/functions.
// Used here to route the menu.gainztrainprep.com subdomain to /menu-selection/ on the main site.

// Internal / non-public files that live in the repo root (the Pages output dir) but must NEVER be
// served. Middleware runs before static-asset serving, so returning here 404s them. The public page
// markdown mirrors (index.md, about/index.md, llms.txt, ...) are deliberately NOT matched.
const BLOCKED_PATHS = [
  /^\/migrations\//, /^\/cron\//, /^\/setup\//,
  /^\/wrangler\.toml$/, /^\/package(-lock)?\.json$/, /^\/\.nvmrc$/,
  /^\/DEPLOY\.md$/, /^\/GHL-TODO\.md$/, /^\/OVERNIGHT_BUILD_REPORT[\w-]*\.md$/,
  /^\/\.dev\.vars$/, /^\/\.prod-secrets/, /^\/\.wrangler\//,
];

export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);

  // Never serve internal repo files (schema, config, runbooks) as static assets.
  if (BLOCKED_PATHS.some((re) => re.test(url.pathname))) {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  }

  // If request comes via the menu subdomain, redirect to the dynamic menu picker page.
  // This avoids needing a separate Pages project — same site serves both hosts.
  if (url.hostname === 'menu.gainztrainprep.com') {
    // Preserve query string + any path after the root
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
