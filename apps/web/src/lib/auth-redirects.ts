/**
 * Keeps Better Auth from sending a browser to another site with an error, which made the hub an open
 * redirect (AUTH-16). Assistants register themselves without an account (D-137), so anyone can
 * register a client whose redirect_uri is any site, and the OAuth provider's authorize endpoint
 * delivers most of its errors to that redirect_uri at once, before anyone saw a page of the hub:
 * `prompt=none` while signed out (`login_required`), an unknown scope, a missing PKCE challenge, a
 * bad resource. A link to `https://<hub>/api/auth/oauth2/authorize?client_id=…&prompt=none` then
 * lands on the attacker's page with the hub's address in the link, which is what phishing mails
 * use open redirects for, and what got the hub's `/api/auth/` listed by Google Safe Browsing.
 *
 * Here such an answer is turned into the hub's own login page with the error code. What still
 * leaves the site: Discord (no error), and a client's redirect_uri with a code (only after the member
 * signed in and allowed that client on the consent page, which names where they go back to) or with
 * `access_denied` after Deny there (the consent route calls the handler itself, not through here).
 * Pure: unit-tested in auth-redirects.test.ts.
 */

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The error a URL carries to another origin than `appOrigin`, or null when it stays here or has none. */
export function offSiteError(target: string, appOrigin: string): string | null {
  let url: URL;
  try {
    url = new URL(target, appOrigin);
  } catch {
    return null;
  }
  if (url.origin === new URL(appOrigin).origin) return null;
  const fromQuery = url.searchParams.get('error');
  if (fromQuery !== null) return fromQuery;
  // Fragment response mode puts the error after `#` (the provider offers query only; this is a guard).
  return new URLSearchParams(url.hash.slice(1)).get('error');
}

/** The login page with the error code, only a plain code; the login page maps it to text. */
function loginWithError(error: string, appOrigin: string): string {
  const code = /^[A-Za-z0-9_.:-]{1,64}$/.test(error) ? error : 'invalid_request';
  return `${new URL(appOrigin).origin}/login?error=${encodeURIComponent(code)}`;
}

/**
 * Better Auth's answer, or the same answer pointing at /login when it would send the browser to
 * another site with an error: a redirect (`Location`), or the `{ redirect: true, url }` JSON the
 * provider answers a fetch with. Only the OAuth provider's paths answer that JSON, so only their
 * bodies are read.
 */
export async function keepErrorsOnSite(
  request: Request,
  response: Response,
  appOrigin: string,
): Promise<Response> {
  const location = response.headers.get('location');
  if (REDIRECT_STATUSES.has(response.status) && location) {
    const error = offSiteError(location, appOrigin);
    if (error === null) return response;
    const headers = new Headers(response.headers);
    headers.set('location', loginWithError(error, appOrigin));
    return new Response(null, { status: 302, headers });
  }

  const path = new URL(request.url).pathname;
  const json = response.headers.get('content-type')?.includes('application/json') ?? false;
  if (!json || !path.includes('/oauth2/')) return response;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  const url = (body as { redirect?: unknown; url?: unknown } | null)?.url;
  if ((body as { redirect?: unknown } | null)?.redirect !== true || typeof url !== 'string') {
    return response;
  }
  const error = offSiteError(url, appOrigin);
  if (error === null) return response;
  const headers = new Headers(response.headers);
  const login = loginWithError(error, appOrigin);
  headers.delete('content-length');
  if (headers.has('location')) headers.set('location', login);
  return new Response(JSON.stringify({ redirect: true, url: login }), {
    status: response.status,
    headers,
  });
}
