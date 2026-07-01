// GET /meal-photos/<key> — public, read-only serving route for meal marketing photos stored in the
// private R2 bucket MEAL_PHOTOS (uploaded via /api/admin/meal-photo). Keeping the bucket private and
// streaming through this Function means: no public-bucket / custom-domain setup, same-origin URLs (no
// CORS), and we control cache + headers. Customers view menu photos with no login, so this stays public
// (the middleware neither blocks nor admin-gates /meal-photos/*).
export async function onRequestGet(context) {
  const { env, params, request } = context;
  if (!env.MEAL_PHOTOS) return new Response('Not configured', { status: 500 });

  // params.path is the catch-all segments after /meal-photos/ (array or string).
  const key = Array.isArray(params.path) ? params.path.join('/') : String(params.path || '');
  if (!key || key.includes('..')) return new Response('Not found', { status: 404 });

  const object = await env.MEAL_PHOTOS.get(key);
  if (!object) return new Response('Not found', { status: 404 });

  // Honor conditional requests for cheap 304s.
  const etag = object.httpEtag;
  if (etag && request.headers.get('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  if (etag) headers.set('ETag', etag);
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(object.body, { headers });
}
