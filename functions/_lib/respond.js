// JSON response helpers for Pages Functions. API responses are never cached.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

export function ok(data = {}, extraHeaders = {}) {
  return json({ ok: true, ...data }, 200, extraHeaders);
}

export function fail(status, code, detail) {
  return json({ ok: false, error: code, ...(detail ? { detail } : {}) }, status);
}

// Parse a JSON request body safely; returns {} on empty/invalid.
export async function readJson(request) {
  try {
    const text = await request.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}
