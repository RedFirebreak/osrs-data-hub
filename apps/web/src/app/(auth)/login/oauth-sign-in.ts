/**
 * The login page as the sign-in step of an assistant's connection (D-137). Better Auth's OAuth
 * provider sends a signed-out browser to /login with the authorization request's parameters, signed
 * (`sig`); "Sign in with Discord" sends them along (oauthProviderClient), and after Discord the
 * provider carries on to the consent page. Pure: unit-tested in oauth-sign-in.test.ts.
 */

type SearchParams = Record<string, string | string[] | undefined>;

/** The parameters the provider adds to sign a request; never part of a fresh authorization. */
const SIGNING_PARAMS = new Set(['sig', 'exp', 'ba_iat', 'ba_param', 'ba_pl']);

/** Whether /login was reached from an assistant's sign-in: a signed request naming a client. */
export function isOAuthSignIn(params: SearchParams): boolean {
  return typeof params.sig === 'string' && typeof params.client_id === 'string';
}

/**
 * For a member who is signed in already: the authorization request again, without the signature and
 * without `prompt=login` (they just proved they're signed in), so the provider goes on to consent.
 */
export function oauthContinueUrl(params: SearchParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || SIGNING_PARAMS.has(key)) continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      if (key === 'prompt') {
        const rest = v.split(' ').filter((p) => p !== '' && p !== 'login');
        if (rest.length > 0) query.append(key, rest.join(' '));
      } else {
        query.append(key, v);
      }
    }
  }
  return `/api/auth/oauth2/authorize?${query.toString()}`;
}
