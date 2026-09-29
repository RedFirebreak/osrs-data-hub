/**
 * What an API key may read (D-70), implemented once on top of the shared loaders (accounts/load.ts):
 * an account is visible to a principal iff it is in the key's account scope AND resolveAccess gives
 * the key's creator at least one category that the key also has; the principal's categories on it
 * are that intersection. Evaluated on every request, so a sharing change or the creator losing
 * access applies at once. The admin override never applies through the API.
 */
import type { Category, Viewer } from '@hub/core';
import type { DbOrTx } from '@hub/db';
import {
  loadVisibleAccount,
  loadVisibleAccounts,
  type AccessRestriction,
  type AccountWithAccess,
} from '../accounts/load';
import { ApiError } from './errors';
import type { ApiPrincipal } from './keys';
import { MAX_LIST_PARAM, isPublicIdLike, listParam } from './params';
import type { ApiAccountRef } from './types';

/** The principal's creator as a viewer, never an admin (D-70). */
export function apiViewer(principal: ApiPrincipal): Viewer {
  return { ...principal.viewer, isAdmin: false };
}

/** The principal's key as a restriction for the shared loaders. */
export function apiRestriction(principal: ApiPrincipal): AccessRestriction {
  return { categories: principal.categories, accountIds: principal.accountIds };
}

/**
 * The account with this public id when the principal may see it (see the module comment), with the
 * narrowed access; null otherwise, and for an id that can't be a public id (never queried, DB-1).
 * With `category`, also null unless the principal may read that category on it.
 */
export async function loadApiAccount(
  db: DbOrTx,
  principal: ApiPrincipal,
  publicId: string,
  category?: Category,
): Promise<AccountWithAccess | null> {
  if (!isPublicIdLike(publicId)) return null;
  const entry = await loadVisibleAccount(
    db,
    apiViewer(principal),
    publicId,
    apiRestriction(principal),
  );
  if (!entry || (category !== undefined && !entry.access.categories.has(category))) return null;
  return entry;
}

/** Every account the principal may see, with the narrowed access. */
export async function loadApiAccounts(
  db: DbOrTx,
  principal: ApiPrincipal,
): Promise<AccountWithAccess[]> {
  return loadVisibleAccounts(db, apiViewer(principal), apiRestriction(principal));
}

/**
 * The accounts named by a list parameter (`ids`, `accounts`), in request order and deduplicated, each
 * of which the principal must be able to read `category` of. Otherwise ApiError 'not_found' naming the
 * first such id: unknown, out of scope and not shared are answered alike (D-70). More than `max`
 * ids, or an empty list, is 'invalid'.
 */
export async function requireApiAccounts(
  db: DbOrTx,
  principal: ApiPrincipal,
  publicIds: readonly string[],
  category: Category,
  name: string,
  max: number = MAX_LIST_PARAM,
): Promise<AccountWithAccess[]> {
  const ids = listParam(publicIds, name, max) ?? [];
  if (ids.length === 0) throw new ApiError('invalid', `${name} must list at least one account`);
  const readable = new Map<string, AccountWithAccess>();
  for (const entry of await loadApiAccounts(db, principal)) {
    if (entry.access.categories.has(category)) readable.set(entry.account.publicId, entry);
  }
  return ids.map((id) => {
    const entry = readable.get(id);
    if (!entry) throw new ApiError('not_found', `account ${id.slice(0, 64)} not found`);
    return entry;
  });
}

/** The account's public id and current name. */
export function accountRef(entry: AccountWithAccess): ApiAccountRef {
  return { id: entry.account.publicId, name: entry.account.name };
}
