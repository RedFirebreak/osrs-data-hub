/**
 * What an API key may read (D-70), implemented once on top of the shared loaders (accounts/load.ts):
 * an account is visible to a principal iff it is in the key's account scope AND resolveAccess gives
 * the key's viewer (its creator, or the guild audience for a service key, D-87/D-88) at least one
 * category that the key also has; the principal's categories on it are that intersection.
 * Evaluated on every request, so a sharing change or the creator losing access applies at once. The
 * admin override never applies through the API.
 */
import { isGuildAudience, type Category, type Principal } from '@hub/core';
import { users, type DbOrTx } from '@hub/db';
import { and, eq, inArray } from 'drizzle-orm';
import {
  loadVisibleAccount,
  loadVisibleAccounts,
  type AccessRestriction,
  type AccountWithAccess,
} from '../accounts/load';
import { ApiError } from './errors';
import type { ApiPrincipal } from './keys';
import { MAX_LIST_PARAM, isPublicIdLike, listParam } from './params';
import type { ApiAccountRef, ApiOwner } from './types';

/** Most accounts one bulk request (`/xp`, `/locations`) may name with a user key (D-91). */
export const MAX_BULK_ACCOUNTS = 10;
/** … and with a service key (D-91): the live map polls its whole guild in one call. */
export const MAX_BULK_ACCOUNTS_SERVICE = 50;

/** Whom the resolver evaluates for this key: its creator, never an admin (D-70), or the guild audience. */
export function apiViewer(principal: ApiPrincipal): Principal {
  return isGuildAudience(principal.viewer)
    ? principal.viewer
    : { ...principal.viewer, isAdmin: false };
}

/** How many accounts a bulk request may name for this key (D-91). */
export function bulkAccountLimit(principal: ApiPrincipal): number {
  return principal.kind === 'service' ? MAX_BULK_ACCOUNTS_SERVICE : MAX_BULK_ACCOUNTS;
}

/**
 * The account's `accountHash` for the response, or undefined (the field is omitted): only service
 * keys get it (D-90). The hash is the plugin's identity for ingest: a member who knew another
 * account's hash could report data for it from their own device and become a contributor who sees
 * everything, so user keys never see it.
 */
export function apiAccountHash(
  principal: ApiPrincipal,
  entry: AccountWithAccess,
): string | undefined {
  return principal.kind === 'service' ? entry.account.accountHash : undefined;
}

/**
 * The owners of `entries` as the API shows them (D-89): the guild page lists every visible account
 * under its owner for every member (D-68), so an account the key may see always carries its owner
 * when that owner is an active user; accounts without an owner, or whose owner is in grace or gone,
 * get null. Contributors are never included. One query for all entries.
 */
export async function loadApiOwners(
  db: DbOrTx,
  entries: readonly AccountWithAccess[],
): Promise<Map<number, ApiOwner | null>> {
  const out = new Map<number, ApiOwner | null>();
  const ownerIds = new Set<string>();
  for (const e of entries) if (e.raw.ownerUserId !== null) ownerIds.add(e.raw.ownerUserId);
  const owners = new Map<string, ApiOwner>();
  if (ownerIds.size > 0) {
    const rows = await db
      .select({ id: users.id, name: users.name, discordId: users.discordId })
      .from(users)
      .where(and(inArray(users.id, [...ownerIds]), eq(users.status, 'active')));
    for (const r of rows) owners.set(r.id, { name: r.name, discordId: r.discordId });
  }
  for (const e of entries) {
    const owner = e.raw.ownerUserId === null ? undefined : owners.get(e.raw.ownerUserId);
    out.set(e.account.id, owner ?? null);
  }
  return out;
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
