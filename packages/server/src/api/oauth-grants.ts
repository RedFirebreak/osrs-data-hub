/**
 * What a user granted an OAuth client (D-137): the consent and the tokens the hub's OAuth provider
 * (Better Auth's oauth-provider plugin) keeps for them. The key a connection made (api_keys with
 * `oauth_client_id`) is what the client's tokens act as; once that key is revoked, the grant is
 * forgotten as well, so the client has to ask again and the user sees the consent page, which makes
 * a new key. Without that, the plugin would skip consent (it remembers it) and hand out tokens that
 * no longer map to any key.
 */
import { createHash } from 'node:crypto';
import { oauthAccessToken, oauthConsent, oauthRefreshToken, type DbOrTx } from '@hub/db';
import { and, eq } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/** Prefix of the access tokens the hub hands out (they act as a key, D-137). */
export const OAUTH_ACCESS_TOKEN_PREFIX = 'ohat_';
/** Prefix of the refresh tokens the hub hands out. */
export const OAUTH_REFRESH_TOKEN_PREFIX = 'ohrt_';

/**
 * How an OAuth token is stored: SHA-256, base64url without padding (the plugin's own default, kept
 * here so the API's key check finds an access token's row the same way). The plugin strips the
 * prefix before hashing, and so does authenticateApiKey.
 */
export function oauthTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/**
 * Forgets what `userId` granted `clientId`: the consent and every access and refresh token. With
 * `clientId` null, every client's. Returns how many rows went.
 */
export async function forgetOAuthGrant(
  db: DbOrTx,
  userId: string,
  clientId: string | null,
): Promise<number> {
  const scope = (t: { userId: AnyPgColumn; clientId: AnyPgColumn }) =>
    clientId === null ? eq(t.userId, userId) : and(eq(t.userId, userId), eq(t.clientId, clientId));
  // Access tokens first: they point at refresh tokens.
  const access = await db.delete(oauthAccessToken).where(scope(oauthAccessToken));
  const refresh = await db.delete(oauthRefreshToken).where(scope(oauthRefreshToken));
  const consent = await db.delete(oauthConsent).where(scope(oauthConsent));
  return (access.rowCount ?? 0) + (refresh.rowCount ?? 0) + (consent.rowCount ?? 0);
}
