/**
 * The key an assistant gets when its user connects it by signing in (D-137): Claude.ai and other MCP
 * clients that only speak OAuth. The hub's OAuth provider hands the client its own tokens; each
 * access token acts as this key, an ordinary user key with the AI assistant categories
 * (AI_ASSISTANT_CATEGORIES), every account the user can see, no expiry, and `oauth_client_id` set.
 * It shows on the API keys page like any other key: edit it to change what the assistant reads,
 * revoke it to disconnect the assistant.
 */
import { AI_ASSISTANT_CATEGORIES, sha256Hex } from '@hub/core';
import { apiKeys, oauthClient, users, type Db, type DbOrTx } from '@hub/db';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { audit } from '../audit';
import { newKeySecret } from './key-format';
import {
  API_KEY_NAME_MAX,
  ApiKeyError,
  MAX_ACTIVE_KEYS,
  activeKeyFilter,
  insertWithFreshPrefix,
  keyInfoOf,
  type ApiKeyInfo,
  type KeyRow,
} from './keys';

/** The name of a connection's key: the client's own name, or this when it gave none. */
export const OAUTH_KEY_FALLBACK_NAME = 'Connected assistant';

/** The client's name as a key name: control characters out, trimmed, at most API_KEY_NAME_MAX. */
export function oauthKeyName(clientName: string | null | undefined): string {
  const name = (clientName ?? '').replace(/\p{Cc}/gu, ' ').trim();
  return name === ''
    ? OAUTH_KEY_FALLBACK_NAME
    : Array.from(name).slice(0, API_KEY_NAME_MAX).join('');
}

/**
 * Makes the key `userId`'s connection to `clientId` acts as, when the user allows it on the consent
 * page. A key this client already had for the user is revoked first (connecting again replaces it),
 * so the limit of MAX_ACTIVE_KEYS counts the new key in its place; over the limit is ApiKeyError
 * 'limit'. The same locks and checks as createApiKey: the user's row first, active users only.
 * Audit: 'api_key.created' with `oauthClientId`, and 'api_key.revoked' for a replaced key.
 * The key's own secret is never handed out: only the client's tokens act as it.
 */
export async function createOAuthKey(
  db: Db,
  opts: { userId: string; clientId: string; clientName: string | null; now?: Date },
): Promise<ApiKeyInfo> {
  const now = opts.now ?? new Date();
  const { userId, clientId } = opts;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('lock_timeout', '3s', true)`);
    const [user] = await tx
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, userId))
      .for('no key update');
    if (!user) throw new ApiKeyError('not_found', 'user not found');
    if (user.status !== 'active') {
      throw new ApiKeyError('invalid', 'only active members can connect an assistant');
    }
    const replaced = await tx
      .update(apiKeys)
      .set({ revokedAt: now })
      .where(
        and(eq(apiKeys.userId, userId), eq(apiKeys.oauthClientId, clientId), activeKeyFilter(now)),
      )
      .returning({ id: apiKeys.id, prefix: apiKeys.prefix });
    for (const old of replaced) {
      await audit(tx, {
        actorUserId: userId,
        action: 'api_key.revoked',
        targetType: 'api_key',
        targetId: old.id,
        meta: { ownerUserId: userId, prefix: old.prefix, asAdmin: false, oauthClientId: clientId },
      });
    }
    const [active] = await tx
      .select({ n: count() })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), activeKeyFilter(now)));
    if ((active?.n ?? 0) >= MAX_ACTIVE_KEYS) {
      throw new ApiKeyError(
        'limit',
        `you already have ${MAX_ACTIVE_KEYS} active API keys; revoke one on the API keys page first`,
      );
    }
    const row = await insertWithFreshPrefix(tx, {
      kind: 'user',
      userId,
      createdByUserId: userId,
      name: oauthKeyName(opts.clientName),
      secretHash: sha256Hex(newKeySecret()),
      categories: [...AI_ASSISTANT_CATEGORIES],
      accountScope: 'all_visible',
      accountIds: null,
      expiresAt: null,
      createdAt: now,
      oauthClientId: clientId,
    });
    await audit(tx, {
      actorUserId: userId,
      action: 'api_key.created',
      targetType: 'api_key',
      targetId: row.id,
      meta: {
        prefix: row.prefix,
        name: row.name,
        categories: row.categories,
        accountScope: row.accountScope,
        accountCount: null,
        expiresAt: null,
        oauthClientId: clientId,
      },
    });
    return keyInfoOf(row, null, now);
  });
}

/** The newest active key `userId`'s connection to `clientId` acts as, or null. */
export async function oauthKeyFor(
  db: DbOrTx,
  userId: string,
  clientId: string,
  now: Date,
): Promise<KeyRow | null> {
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(
      and(eq(apiKeys.userId, userId), eq(apiKeys.oauthClientId, clientId), activeKeyFilter(now)),
    )
    .orderBy(desc(apiKeys.createdAt))
    .limit(1);
  return row ?? null;
}

/** An OAuth client as the consent page shows it. */
export interface OAuthClientInfo {
  clientId: string;
  /** What the client calls itself (RFC 7591 `client_name`), or null. */
  name: string | null;
  /** Its home page (`client_uri`), or null. */
  uri: string | null;
}

/** The client `clientId`, or null when there's none or it is disabled. */
export async function oauthClientInfo(
  db: DbOrTx,
  clientId: string,
): Promise<OAuthClientInfo | null> {
  const [row] = await db
    .select({
      clientId: oauthClient.clientId,
      name: oauthClient.name,
      uri: oauthClient.uri,
      disabled: oauthClient.disabled,
    })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId));
  if (!row || row.disabled === true) return null;
  return { clientId: row.clientId, name: row.name, uri: row.uri };
}
