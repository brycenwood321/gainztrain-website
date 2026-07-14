// POST /api/admin/meal-photo?name=<meal name> — upload a meal marketing photo from the prep dashboard's
// "New Meal" form. Staff-gated (requireOwner). The browser resizes/compresses the photo to a small
// JPEG before sending, so the body is raw image bytes (Content-Type image/jpeg|png|webp), NOT multipart.
//
// Stored in the private R2 bucket MEAL_PHOTOS under meals/<slug>-<id>.<ext>. Served back same-origin by
// functions/meal-photos/[[path]].js. Returns { ok, url } where url is a site-relative path saved onto the
// meal (meal.image) and later published to weekly_menus by finalize-menu.js so the customer picker shows it.
import { ok, fail } from '../../_lib/respond.js';
import { requireOwner } from '../../_lib/admin.js';

const MAX_BYTES = 5 * 1024 * 1024; // 5MB server ceiling (client resizes to well under this)
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function slugify(s) {
  return String(s || 'meal').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'meal';
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const denied = await requireOwner(context);
  if (denied) return denied;

  if (!env.MEAL_PHOTOS) return fail(500, 'no_bucket', 'Photo storage is not configured.');

  const ct = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  const ext = EXT[ct];
  if (!ext) return fail(415, 'bad_type', 'Upload a JPEG, PNG, or WebP image.');

  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength) return fail(400, 'empty', 'No image data received.');
  if (bytes.byteLength > MAX_BYTES) return fail(413, 'too_large', 'Image is too large (max 5MB).');

  const name = new URL(request.url).searchParams.get('name') || '';
  const id = crypto.randomUUID().slice(0, 8);
  const key = `meals/${slugify(name)}-${id}.${ext}`;

  await env.MEAL_PHOTOS.put(key, bytes, {
    httpMetadata: { contentType: ct, cacheControl: 'public, max-age=31536000, immutable' },
  });

  return ok({ url: `/meal-photos/${key}`, key });
}
