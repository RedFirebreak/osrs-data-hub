/**
 * GET /accounts and GET /accounts/{id} of the public API (handoff §13): the accounts a key may see,
 * and one account's current state by category.
 */
import { CATEGORIES, accountTypeLabel, floorTo, normalizeName, type Category } from '@hub/core';
import type { DbOrTx } from '@hub/db';
import { loadPresence, toPresence, type AccountWithAccess } from '../accounts/load';
import { loadApiAccount, loadApiAccounts } from './access';
import type { ApiPrincipal } from './keys';
import { listParam } from './params';
import {
  itemsOf,
  loadLatestRows,
  locationOf,
  presenceOf,
  skillsOf,
  vitalsFrom,
  vitalsUpdatedAt,
  type ApiEquipment,
  type ApiInventory,
  type ApiLocation,
  type ApiPresence,
  type ApiSkills,
  type ApiVitals,
  type LatestRow,
} from './state';
import type { ApiSection } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** One account in GET /accounts. */
export interface ApiAccountSummary {
  id: string;
  name: string;
  /** IRONMAN varbit: 0 normal, 1 IM, 2 UIM, 3 HCIM, 4 GIM, 5 HCGIM, 6 UGIM; null when never sent. */
  type: number | null;
  /** "Normal", "Ironman", … ("Unknown" for null). */
  typeLabel: string;
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
  const out: ApiAccountSummary[] = [];
  for (const entry of selected) {
    const { account } = entry;
    const activity = entry.access.categories.has('activity');
    const row = activity ? presence.get(account.id) : undefined;
    const online = activity ? (row ? toPresence(row, now).online : false) : null;
    if (params.online !== undefined && online !== params.online) continue;
    out.push({
      id: account.publicId,
      name: account.name,
      type: account.accountType,
      typeLabel: accountTypeLabel(account.accountType),
      online,
      world: row?.world ?? null,
      lastSeen: activity ? (row?.lastSeen ?? account.lastSeen).toISOString() : null,
    });
  }
  return out.sort((a, b) => byName(a.name, b.name) || a.id.localeCompare(b.id));
}

/**
 * One account's current state (GET /accounts/{id}). Each section follows ApiSection: present with
 * `shared: true` and its data, present with `shared: false` when the plugin never sent it, and
 * OMITTED (the key doesn't hold the category on this account) — see ApiSection.
 */
export interface ApiAccountDetail {
  id: string;
  name: string;
  type: number | null;
  typeLabel: string;
  /** When the hub first saw the account. */
  firstSeen: string;
  /** What this key may read on this account: its categories ∩ what the owner shares with its creator. */
  categories: Category[];
  /** `activity`; `updatedAt` = when the hub last heard from the account. */
  presence?: ApiSection<ApiPresence>;
  /** `activity`. */
  vitals?: ApiSection<ApiVitals>;
  /** `stats`. */
  skills?: ApiSection<ApiSkills>;
  /** `location_live`; its `updatedAt` is exact (a live position is presence by nature). */
  location?: ApiSection<ApiLocation>;
  /** `equipment`. */
  equipment?: ApiSection<ApiEquipment>;
  /** `inventory`. */
  inventory?: ApiSection<ApiInventory>;
}

/**
 * The current state of one account by category, or null when the key may not see it (unknown, out
 * of scope, none of the key's categories shared with its creator: the web answers all with the same
 * 404, D-70). Sections of categories the key lacks are omitted. Without `activity`, the `updatedAt`
 * of skills, equipment and inventory is cut to the UTC day: the plugin sends them with every periodic
 * update, so the exact time would be the last-seen time the owner didn't share (D-50).
 */
export async function apiGetAccount(
  db: DbOrTx,
  principal: ApiPrincipal,
  id: string,
  now: Date = new Date(),
): Promise<ApiAccountDetail | null> {
  const entry = await loadApiAccount(db, principal, id);
  if (!entry) return null;
  const can = (c: Category) => entry.access.categories.has(c);
  const rows = await loadLatestRows(db, [entry.account.id], {
    skills: can('stats'),
    equipment: can('equipment'),
    inventory: can('inventory'),
  });
  return accountDetail(entry, rows.get(entry.account.id), now);
}

function accountDetail(
  entry: AccountWithAccess,
  row: LatestRow | undefined,
  now: Date,
): ApiAccountDetail {
  const { account, access } = entry;
  const can = (c: Category) => access.categories.has(c);
  // See apiGetAccount: without activity, only the day of sections sent with every update (D-50).
  const stamp = (at: Date | null) => (at === null || can('activity') ? at : floorTo(at, DAY_MS));
  const out: ApiAccountDetail = {
    id: account.publicId,
    name: account.name,
    type: account.accountType,
    typeLabel: accountTypeLabel(account.accountType),
    firstSeen: account.firstSeen.toISOString(),
    categories: CATEGORIES.filter(can),
  };
  if (can('activity')) {
    out.presence = section(row?.lastSeen ?? null, row ? presenceOf(row, now) : null);
    out.vitals = section(row ? vitalsUpdatedAt(row) : null, row ? vitalsFrom(row) : null);
  }
  if (can('stats')) {
    out.skills = section(stamp(row?.skillsUpdatedAt ?? null), row ? skillsOf(row) : null);
  }
  if (can('location_live')) {
    out.location = section(row?.locationUpdatedAt ?? null, row ? locationOf(row, now) : null);
  }
  if (can('equipment')) {
    const at = row?.equipmentUpdatedAt ?? null;
    out.equipment = section(stamp(at), row ? itemsOf(row.equipment, at) : null);
  }
  if (can('inventory')) {
    const at = row?.inventoryUpdatedAt ?? null;
    out.inventory = section(stamp(at), row ? itemsOf(row.inventory, at) : null);
  }
  return out;
}

/** A shared section when there is data and a time, else "not shared". */
function section<T extends object>(updatedAt: Date | null, data: T | null): ApiSection<T> {
  if (updatedAt === null || data === null) return { shared: false, updatedAt: null };
  return { ...data, shared: true, updatedAt: updatedAt.toISOString() };
}

function byName(a: string, b: string): number {
  return a.localeCompare(b, 'en', { sensitivity: 'base' });
}
