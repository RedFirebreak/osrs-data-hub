/**
 * The consent step of an MCP client's sign-in (D-137), shared by the consent page and its route.
 * Better Auth's OAuth provider sends the browser to /oauth/consent with the authorization request's
 * parameters, signed with the auth secret (`sig`, `exp`); only a request whose signature holds and
 * that hasn't expired is shown, so nobody can put words in a consent page by crafting a link.
 */
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import type { DbOrTx } from '@hub/db';
import { oauthClientInfo, type OAuthClientInfo } from '@hub/server';
import { getAuth } from '@/lib/auth';

/** Longest signed query accepted: a real one is well under 2 KiB. */
const MAX_OAUTH_QUERY_LENGTH = 8 * 1024;

export interface ConsentRequest {
  /** The signed query as received, handed back to the provider unchanged. */
  oauthQuery: string;
  client: OAuthClientInfo;
  /** Where the browser goes next: the host of the client's redirect URI, shown to the member. */
  redirectHost: string | null;
}

/**
 * The search parameters of the consent page as the signed query string, repeated keys kept in
 * order (the signature covers `ba_param`, which repeats).
 */
export function oauthQueryOf(params: Record<string, string | string[] | undefined>): string {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) out.append(key, v);
  }
  return out.toString();
}

/** The signed request, or null when it isn't one (forged, expired, unknown or disabled client). */
export async function readConsentRequest(
  db: DbOrTx,
  oauthQuery: string,
): Promise<ConsentRequest | null> {
  if (oauthQuery === '' || oauthQuery.length > MAX_OAUTH_QUERY_LENGTH) return null;
  const { secret } = await getAuth().$context;
  if (!(await verifyOAuthQueryParams(oauthQuery, secret))) return null;
  const params = new URLSearchParams(oauthQuery);
  const clientId = params.get('client_id');
  if (!clientId) return null;
  const client = await oauthClientInfo(db, clientId);
  if (!client) return null;
  return { oauthQuery, client, redirectHost: hostOf(params.get('redirect_uri')) };
}

function hostOf(uri: string | null): string | null {
  if (!uri) return null;
  try {
    return new URL(uri).host || null;
  } catch {
    return null;
  }
}
