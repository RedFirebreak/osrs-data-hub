/**
 * CORS for /api/v1 (D-71): any origin may read the API (the live map runs in a browser), without
 * credentials: keys travel in the Authorization header and cookies are never read, so
 * `Access-Control-Allow-Credentials` is never sent. Every /api/v1 response carries these headers,
 * errors included (a browser client can't read a 401 or a 429 without them), and OPTIONS answers the
 * preflight with 204 without authentication or rate limiting.
 */

/** On every /api/v1 response. */
const CORS_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers':
    'ETag, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
};

/** Only on the preflight answer. */
const PREFLIGHT_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, If-None-Match, Content-Type',
  'Access-Control-Max-Age': '600',
};

/**
 * Sets the CORS headers, and `extra` (the X-RateLimit-* headers), on `res`; on a copy when its headers
 * are immutable.
 */
export function withCors(res: Response, extra: Readonly<Record<string, string>> = {}): Response {
  const all = { ...extra, ...CORS_HEADERS };
  try {
    for (const [name, value] of Object.entries(all)) res.headers.set(name, value);
    return res;
  } catch {
    const headers = new Headers(res.headers);
    for (const [name, value] of Object.entries(all)) headers.set(name, value);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}

/** OPTIONS on every /api/v1 route: 204, no auth, no rate limit. */
export function preflight(): Response {
  return new Response(null, { status: 204, headers: { ...CORS_HEADERS, ...PREFLIGHT_HEADERS } });
}
