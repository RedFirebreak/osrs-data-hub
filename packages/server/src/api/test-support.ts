/**
 * Helpers for the public API tests (imported by *.test.ts only, not exported from the package).
 */
import { CATEGORIES, type Category } from '@hub/core';
import type { Db } from '@hub/db';
import { authenticateApiKey, type ApiPrincipal } from './key-auth';
import { createApiKey, type ApiKeyInfo } from './keys';

export interface TestKey {
  key: string;
  info: ApiKeyInfo;
  principal: ApiPrincipal;
}

/**
 * Creates a key for `userId` through createApiKey (every category, all visible accounts, unless
 * overridden) and authenticates it, so the principal is exactly what a request would act as.
 */
export async function makeKey(
  db: Db,
  userId: string,
  input: {
    name?: string;
    categories?: Category[];
    accountScope?: 'all_visible' | 'list';
    accountPublicIds?: string[];
    expiresInDays?: number | null;
  } = {},
  now: Date = new Date(),
): Promise<TestKey> {
  const { key, info } = await createApiKey(
    db,
    userId,
    { name: 'test key', categories: [...CATEGORIES], accountScope: 'all_visible', ...input },
    now,
  );
  const auth = await authenticateApiKey(db, `Bearer ${key}`, now);
  if (!auth.ok) throw new Error(`makeKey: authentication failed (${auth.reason})`);
  return { key, info, principal: auth.principal };
}

/** A principal re-authenticated now (what the next request would act as). */
export async function reauth(db: Db, key: string, now: Date = new Date()): Promise<ApiPrincipal> {
  const auth = await authenticateApiKey(db, `Bearer ${key}`, now);
  if (!auth.ok) throw new Error(`reauth: authentication failed (${auth.reason})`);
  return auth.principal;
}

/** Throws unless `value` is not null (read models answer null for "404"). */
export function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value, got null');
  return value;
}
