/** GET /me of the public API (handoff §13): the key, its creator and how many accounts it sees. */
import { CATEGORIES, type Category } from '@hub/core';
import { apiKeys, users, type DbOrTx } from '@hub/db';
import { eq } from 'drizzle-orm';
import { loadApiAccounts } from './access';
import type { ApiKeyScope, ApiPrincipal } from './keys';

export interface ApiMe {
  key: {
    id: string;
    name: string;
    /** The 10-character prefix (the key is `ohub_<prefix>_<secret>`). */
    prefix: string;
    /** The key's categories, in the order of CATEGORIES (what it may read where shared). */
    categories: Category[];
    accountScope: ApiKeyScope;
    expiresAt: string | null;
  };
  /** The key's creator: every request sees what they may see right now, narrowed by the key. */
  user: { name: string };
  /** Accounts the key can see right now (D-70). */
  visibleAccounts: number;
}

/**
 * The key behind the request, its creator's display name, and the number of accounts it can see
 * right now. Throws when the key or its creator is gone: authenticateApiKey has just loaded both.
 */
export async function apiMe(db: DbOrTx, principal: ApiPrincipal): Promise<ApiMe> {
  const [key] = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      categories: apiKeys.categories,
      accountScope: apiKeys.accountScope,
      expiresAt: apiKeys.expiresAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.id, principal.keyId));
  const [user] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, principal.userId));
  if (!key || !user) throw new Error('apiMe: the authenticated key or its creator is gone');
  const visible = await loadApiAccounts(db, principal);
  return {
    key: {
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      categories: CATEGORIES.filter((c) => key.categories.includes(c)),
      accountScope: key.accountScope,
      expiresAt: key.expiresAt?.toISOString() ?? null,
    },
    user: { name: user.name },
    visibleAccounts: visible.length,
  };
}
