/** GET /me of the public API (handoff §13): the key, its creator and how many accounts it sees. */
import { CATEGORIES, type Category } from '@hub/core';
import { apiKeys, users, type ApiKeyKind, type DbOrTx } from '@hub/db';
import { eq } from 'drizzle-orm';
import { loadApiAccounts } from './access';
import { keyRateLimit, type ApiKeyScope, type ApiPrincipal } from './keys';

export interface ApiMe {
  key: {
    id: string;
    /** `user` (a member's key) or `service` (an integration key, D-88). */
    kind: ApiKeyKind;
    name: string;
    /** The 10-character prefix (the key is `ohub_<prefix>_<secret>`). */
    prefix: string;
    /** The key's categories, in the order of CATEGORIES (what it may read where shared). */
    categories: Category[];
    accountScope: ApiKeyScope;
    /** Requests per sliding minute (D-72, D-88). */
    rateLimitPerMinute: number;
    expiresAt: string | null;
  };
  /**
   * The key's creator: every request sees what they may see right now, narrowed by the key. Null for
   * a service key, which belongs to no user and sees the guild audience (D-88).
   */
  user: { name: string } | null;
  /** Accounts the key can see right now (D-70). */
  visibleAccounts: number;
}

/**
 * The key behind the request, its creator's display name (null for a service key), and the number
 * of accounts it can see right now. Throws when the key or its creator is gone: authenticateApiKey
 * has just loaded both.
 */
export async function apiMe(db: DbOrTx, principal: ApiPrincipal): Promise<ApiMe> {
  const [key] = await db
    .select({
      id: apiKeys.id,
      kind: apiKeys.kind,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      categories: apiKeys.categories,
      accountScope: apiKeys.accountScope,
      rateLimitPerMinute: apiKeys.rateLimitPerMinute,
      expiresAt: apiKeys.expiresAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.id, principal.keyId));
  if (!key) throw new Error('apiMe: the authenticated key is gone');
  let user: { name: string } | null = null;
  if (principal.userId !== null) {
    const [creator] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, principal.userId));
    if (!creator) throw new Error('apiMe: the authenticated key has no creator');
    user = { name: creator.name };
  }
  const visible = await loadApiAccounts(db, principal);
  return {
    key: {
      id: key.id,
      kind: key.kind,
      name: key.name,
      prefix: key.prefix,
      categories: CATEGORIES.filter((c) => key.categories.includes(c)),
      accountScope: key.accountScope,
      rateLimitPerMinute: keyRateLimit(key),
      expiresAt: key.expiresAt?.toISOString() ?? null,
    },
    user,
    visibleAccounts: visible.length,
  };
}
