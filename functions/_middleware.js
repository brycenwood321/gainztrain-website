// Cloudflare Pages middleware — runs on every request before reaching pages/functions.
// Used here to route the menu.gainztrainprep.com subdomain to /menu-selection/ on the main site.

export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);

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
