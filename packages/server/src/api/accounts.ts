/**
 * GET /accounts and GET /accounts/{id} of the public API (handoff §13): the accounts a key may see,
 * and one account's current state by category.
 */
import { CATEGORIES, normalizeName, type Category } from '@hub/core';
import type { DbOrTx } from '@hub/db';
import { loadPresence, toPresence } from '../accounts/load';
import { accountIdentity, loadApiAccount, loadApiAccounts, loadApiOwners } from './access';
import type { ApiPrincipal } from './keys';
import { listParam } from './params';
import { loadAccountSections, type ApiStateSections } from './state';
import type { ApiAccountIdentity } from './types';

/** One account in GET /accounts. */
export interface ApiAccountSummary extends ApiAccountIdentity {
  /** In game now; null when the key can't read the account's `activity`. */
  online: boolean | null;
  /** Last known world; null without `activity` (or when never sent). */
  world: number | null;
  /** When the hub last heard from the account; null without `activity` (D-50). */
  lastSeen: string | null;
}

export interface ApiListAccountsParams {
  /** Current display names, matched case-insensitively the way the game does (normalizeName). */
  names?: string[];
  /** Public ids. */
  ids?: string[];
  /** true: only accounts in game now; false: only accounts known to be offline. */
  online?: boolean;
}

/**
 * The accounts the key may see (D-70), sorted by name. `names` and `ids` select accounts (an
 * account matching either list is returned; an empty or missing list selects nothing extra, and
 * with neither list every account is returned); names and ids that match nothing are simply absent.
 * `online` then keeps only accounts whose presence the key can read (`activity`) and whose online
 * state equals it, so accounts without `activity` never pass an `online` filter. At most
 * MAX_LIST_PARAM names and ids each (ApiError invalid).
 */
export async function apiListAccounts(
  db: DbOrTx,
  principal: ApiPrincipal,
  params: ApiListAccountsParams = {},
  now: Date = new Date(),
): Promise<ApiAccountSummary[]> {
  const names = listParam(params.names, 'names') ?? [];
  const ids = listParam(params.ids, 'ids') ?? [];
  const nameKeys = new Set(names.map((n) => normalizeName(n)));
  const idSet = new Set(ids);
  const selecting = nameKeys.size > 0 || idSet.size > 0;
  const selected = (await loadApiAccounts(db, principal)).filter(
    ({ account }) =>
      !selecting || idSet.has(account.publicId) || nameKeys.has(normalizeName(account.name)),
  );
  const presence = await loadPresence(
    db,
    selected.filter((e) => e.access.categories.has('activity')).map((e) => e.account.id),
  );
  const owners = await loadApiOwners(db, selected);
  const out: ApiAccountSummary[] = [];
  for (const entry of selected) {
    const { account } = entry;
    const activity = entry.access.categories.has('activity');
    const row = activity ? presence.get(account.id) : undefined;
    const online = activity ? (row ? toPresence(row, now).online : false) : null;
    if (params.online !== undefined && online !== params.online) continue;
    out.push({
      ...accountIdentity(principal, entry, owners),
      online,
      world: row?.world ?? null,
      lastSeen: activity ? (row?.lastSeen ?? account.lastSeen).toISOString() : null,
    });
  }
  return out.sort((a, b) => byName(a.name, b.name) || a.id.localeCompare(b.id));
}

/**
 * One account's current state (GET /accounts/{id}). Each section (ApiStateSections) follows
 * ApiSection: present with `shared: true` and its data, present with `shared: false` when the plugin
 * never sent it, and OMITTED (the key doesn't hold the category on this account) — see ApiSection.
 */
export interface ApiAccountDetail extends ApiAccountIdentity, ApiStateSections {
  /** When the hub first saw the account. */
  firstSeen: string;
  /** What this key may read on this account: its categories ∩ what the owner shares with its creator. */
  categories: Category[];
}

/**
 * The current state of one account by category, or null when the key may not see it (unknown, out
 * of scope, none of the key's categories shared with its creator: the web answers all with the same
 * 404, D-70). Sections of categories the key lacks are omitted, and without `activity` the
 * `updatedAt` of skills, equipment and inventory carries only the UTC day (D-50): see accountSections.
 */
export async function apiGetAccount(
  db: DbOrTx,
  principal: ApiPrincipal,
  id: string,
  now: Date = new Date(),
): Promise<ApiAccountDetail | null> {
  const entry = await loadApiAccount(db, principal, id);
  if (!entry) return null;
  const { account, access } = entry;
  const sections = await loadAccountSections(db, account.id, access.categories, now);
  const owners = await loadApiOwners(db, [entry]);
  return {
    ...accountIdentity(principal, entry, owners),
    firstSeen: account.firstSeen.toISOString(),
    categories: CATEGORIES.filter((c) => access.categories.has(c)),
    ...sections,
  };
}

function byName(a: string, b: string): number {
  return a.localeCompare(b, 'en', { sensitivity: 'base' });
}
