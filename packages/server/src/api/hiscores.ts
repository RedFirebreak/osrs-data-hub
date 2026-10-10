/**
 * GET /accounts/{id}/hiscores and GET /hiscores of the public API (D-105): what the hub read from
 * the official hiscores (`hiscores`), with each row's rank on the account's own iron table.
 */
import { DAY_MS, floorTo } from '@hub/core';
import type { DbOrTx } from '@hub/db';
import { loadHiscoresViews, type HiscoresView } from '../hiscores/read';
import {
  accountRef,
  bulkAccountLimit,
  loadApiAccount,
  loadApiAccounts,
  requireApiAccounts,
} from './access';
import type { ApiPrincipal } from './key-auth';
import type { ApiAccountRef } from './types';
import type { AccountWithAccess } from '../accounts/load';

/** One account's hiscores. */
export interface ApiHiscores extends HiscoresView {
  account: ApiAccountRef;
}

/** One account's hiscores, or null when the key can't read its `hiscores` (D-70). */
export async function apiHiscores(
  db: DbOrTx,
  principal: ApiPrincipal,
  id: string,
): Promise<ApiHiscores | null> {
  const entry = await loadApiAccount(db, principal, id, 'hiscores');
  if (!entry) return null;
  return (await toApi(db, [entry]))[0]!;
}

/**
 * The hiscores of several accounts (GET /hiscores?accounts=a,b): the named ones in request order, at
 * most bulkAccountLimit(principal), each of which the key must read `hiscores` of, else ApiError
 * 'not_found' naming it (D-70, D-92). Without `ids`, every visible account whose `hiscores` the key
 * reads, sorted by name.
 */
export async function apiHiscoresMulti(
  db: DbOrTx,
  principal: ApiPrincipal,
  params: { ids?: string[] } = {},
): Promise<ApiHiscores[]> {
  const entries =
    params.ids === undefined
      ? (await loadApiAccounts(db, principal))
          .filter((e) => e.access.categories.has('hiscores'))
          .sort(
            (a, b) =>
              a.account.name.localeCompare(b.account.name, 'en', { sensitivity: 'base' }) ||
              a.account.publicId.localeCompare(b.account.publicId),
          )
      : await requireApiAccounts(
          db,
          principal,
          params.ids,
          'hiscores',
          'accounts',
          bulkAccountLimit(principal),
        );
  return toApi(db, entries);
}

/**
 * Without `activity`, `fetchedAt` is cut to the UTC day: an account is looked up about 10 minutes
 * after its session ends, so the exact time would tell the last-seen time the owner didn't share
 * (D-50).
 */
async function toApi(db: DbOrTx, entries: readonly AccountWithAccess[]): Promise<ApiHiscores[]> {
  const views = await loadHiscoresViews(
    db,
    entries.map((e) => ({ id: e.account.id, accountType: e.account.accountType })),
  );
  return entries.map((e) => {
    const view = views.get(e.account.id)!;
    const fetchedAt =
      view.fetchedAt === null || e.access.categories.has('activity')
        ? view.fetchedAt
        : floorTo(new Date(view.fetchedAt), DAY_MS).toISOString();
    return { account: accountRef(e), ...view, fetchedAt };
  });
}
