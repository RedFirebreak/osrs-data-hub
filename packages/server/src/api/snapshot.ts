/**
 * GET /snapshot of the public API (handoff §13, D-74): the current state of every account in the
 * key's scope, built for polling every 2–10 s (the live map, Home Assistant). One query set for all
 * accounts: the shared account loader (with the key's restriction) and one latest_state read.
 */
import { createHash } from 'node:crypto';
import {
  CATEGORIES,
  IN_GAME_STATES,
  LOCATION_STALE_MS,
  presenceTimeoutSeconds,
  type Category,
} from '@hub/core';
import type { DbOrTx } from '@hub/db';
import { locationOf, vitalsOf } from '../accounts/account-page';
import { toPresence, type AccountWithAccess } from '../accounts/load';
import { accountIdentity, loadApiAccounts, loadApiOwners } from './access';
import type { ApiPrincipal } from './keys';
import { assertDate } from './params';
import {
  itemsOf,
  loadLatestRows,
  skillsOf,
  type ApiEquipment,
  type ApiInventory,
  type ApiLocation,
  type ApiSkills,
  type LatestRow,
} from './state';
import type { ApiAccountIdentity, ApiMeter } from './types';

/**
 * `since` also returns accounts that changed up to this long before it. latest_state.updated_at is
 * the payload's receive time, taken before its transaction, which can commit several seconds later
 * (lock waits, retries): a change can become visible with a time older than a `since` handed out in
 * between, the same problem as a seq cursor (DB-4). Answering an overlap costs a few duplicate
 * accounts, which consumers merge anyway.
 */
export const SNAPSHOT_SINCE_OVERLAP_MS = 30_000;

/** The live location in a snapshot entry, with when it was received. */
export interface ApiSnapshotLocation extends ApiLocation {
  updatedAt: string;
}

/**
 * One account in a snapshot. `id`, `name`, `type`, `typeLabel`, `owner` and `categories` are always
 * present (`accountHash` for service keys, D-91); every other field belongs to one category and is
 * OMITTED when the key can't read that category on the account (null means "readable, but the
 * plugin never sent it").
 */
export interface ApiSnapshotAccount extends ApiAccountIdentity {
  /** What this key may read on this account. */
  categories: Category[];
  /** `activity`: in game now (D-28). */
  online?: boolean;
  /** `activity`: last known world. */
  world?: number | null;
  /** `activity`: the last known world is a special one. */
  specialWorld?: boolean;
  /**
   * `activity`: the last game state as sent (LOGGED_IN, LOGIN_SCREEN, HOPPING, …), as on
   * /accounts/{id}, except null once an in-game state timed out (online went false without the
   * plugin saying so, e.g. a crashed client), so it never claims "logged in" for an offline account.
   */
  gameState?: string | null;
  /** `activity`: when the hub last heard from the account. */
  lastSeen?: string;
  /** `activity`. */
  hp?: ApiMeter | null;
  /** `activity`. */
  prayer?: ApiMeter | null;
  /** `activity`. */
  spellbook?: string | null;
  /** `location_live`: `stale` after 2 minutes without a location (D-74). */
  location?: ApiSnapshotLocation | null;
  /** `stats`: Overall first, then the in-game grid order. */
  skills?: ApiSkills | null;
  /** `equipment`. */
  equipment?: ApiEquipment | null;
  /** `inventory`. */
  inventory?: ApiInventory | null;
}

export interface ApiSnapshot {
  /** Sorted by name. With `since`, only the accounts that changed (see apiSnapshot). */
  accounts: ApiSnapshotAccount[];
  /**
   * Weak ETag of this response for this key (`W/"…"`): unchanged as long as the response would be
   * identical. Send it back as If-None-Match; etagMatches tells whether to answer 304.
   */
  etag: string;
  /**
   * The newest change among the accounts whose `activity` the key can read (their data, or presence
   * running out, or the location going stale), for Last-Modified and the next `since`; null when the
   * key reads no account's `activity`.
   */
  lastModified: string | null;
}

/**
 * Every account the key may see (D-70) with its current state by category (see ApiSnapshotAccount).
 *
 * With `since`, only accounts that changed after `since − SNAPSHOT_SINCE_OVERLAP_MS`, where a change
 * is new data, or a derived value that flipped with time: presence timing out (online → false) and
 * the location going stale. Accounts whose `activity` the key can't read are ALWAYS returned: when
 * their data changed is when the player was last seen, which the owner didn't share with the key
 * (D-50). An account that leaves the key's scope just stops appearing, so a consumer using `since`
 * should fetch without it now and then.
 *
 * The ETag hashes the key id and the response (not only "the newest change and the count", D-74):
 * presence and staleness change with time alone, and a sharing change changes what a key sees
 * without any new data.
 */
export async function apiSnapshot(
  db: DbOrTx,
  principal: ApiPrincipal,
  params: { since?: Date } = {},
  now: Date = new Date(),
): Promise<ApiSnapshot> {
  if (params.since !== undefined) assertDate(params.since, 'since');
  const visible = await loadApiAccounts(db, principal);
  const anyHas = (c: Category) => visible.some((e) => e.access.categories.has(c));
  const rows = await loadLatestRows(
    db,
    visible.map((e) => e.account.id),
    { skills: anyHas('stats'), equipment: anyHas('equipment'), inventory: anyHas('inventory') },
  );

  const owners = await loadApiOwners(db, visible);
  const sinceMs =
    params.since === undefined ? null : params.since.getTime() - SNAPSHOT_SINCE_OVERLAP_MS;
  let newest: number | null = null;
  const accounts: ApiSnapshotAccount[] = [];
  for (const entry of sortByName(visible)) {
    const row = rows.get(entry.account.id);
    const changed = entry.access.categories.has('activity') ? changedAt(entry, row, now) : null;
    if (changed !== null) newest = Math.max(newest ?? changed, changed);
    if (sinceMs !== null && changed !== null && changed <= sinceMs) continue;
    accounts.push(snapshotAccount(entry, row, now, accountIdentity(principal, entry, owners)));
  }
  const lastModified = newest === null ? null : new Date(newest).toISOString();
  return { accounts, etag: snapshotEtag(principal.keyId, accounts, lastModified), lastModified };
}

function snapshotAccount(
  entry: AccountWithAccess,
  row: LatestRow | undefined,
  now: Date,
  identity: ApiAccountIdentity,
): ApiSnapshotAccount {
  const { account, access } = entry;
  const can = (c: Category) => access.categories.has(c);
  const out: ApiSnapshotAccount = { ...identity, categories: CATEGORIES.filter(can) };
  if (can('activity')) {
    const presence = row ? toPresence(row, now) : null;
    const vitals = row ? vitalsOf(row) : null;
    out.online = presence?.online ?? false;
    out.world = presence?.world ?? null;
    out.specialWorld = presence?.specialWorld ?? false;
    // An in-game state with online false means presence timed out: the state is stale (D-94).
    const gameState = presence?.gameState ?? null;
    out.gameState =
      presence && !presence.online && gameState !== null && IN_GAME_STATES.has(gameState)
        ? null
        : gameState;
    out.lastSeen = (row?.lastSeen ?? account.lastSeen).toISOString();
    out.hp = vitals?.hp ?? null;
    out.prayer = vitals?.prayer ?? null;
    out.spellbook = vitals?.spellbook ?? null;
  }
  if (can('location_live')) {
    const location = row ? locationOf(row, now) : null;
    out.location =
      location && row?.locationUpdatedAt
        ? { ...location, updatedAt: row.locationUpdatedAt.toISOString() }
        : null;
  }
  if (can('stats')) out.skills = row ? skillsOf(row) : null;
  if (can('equipment')) out.equipment = row ? itemsOf(row.equipment, row.equipmentUpdatedAt) : null;
  if (can('inventory')) out.inventory = row ? itemsOf(row.inventory, row.inventoryUpdatedAt) : null;
  return out;
}

/**
 * When the account's snapshot entry last changed (epoch ms), for a key that reads its `activity`:
 * its newest data (latest_state.updated_at, the account row's last_seen), or a moment at or before
 * `now` when a derived value flipped: presence timing out (isOnline turns false when
 * now − lastSeen reaches the timeout) and the live location turning stale.
 */
function changedAt(entry: AccountWithAccess, row: LatestRow | undefined, now: Date): number {
  let t = entry.account.lastSeen.getTime();
  if (!row) return t;
  t = Math.max(t, row.updatedAt.getTime(), row.lastSeen.getTime());
  const nowMs = now.getTime();
  if (row.gameState !== null && IN_GAME_STATES.has(row.gameState)) {
    const offlineAt = row.lastSeen.getTime() + presenceTimeoutSeconds(row.tickDelay) * 1000;
    if (offlineAt <= nowMs) t = Math.max(t, offlineAt);
  }
  if (entry.access.categories.has('location_live') && row.locationUpdatedAt !== null) {
    const staleAt = row.locationUpdatedAt.getTime() + LOCATION_STALE_MS;
    if (staleAt < nowMs) t = Math.max(t, staleAt);
  }
  return t;
}

function snapshotEtag(
  keyId: string,
  accounts: readonly ApiSnapshotAccount[],
  lastModified: string | null,
): string {
  const hash = createHash('sha256')
    .update(keyId)
    .update('\n')
    .update(JSON.stringify({ accounts, lastModified }))
    .digest('base64url')
    .slice(0, 27);
  return `W/"${hash}"`;
}

/**
 * Whether an If-None-Match header matches `etag` (RFC 9110 §13.1.2, weak comparison): `*`, or any
 * entity tag of the comma-separated list equal to it with any `W/` prefix ignored. A missing or
 * empty header never matches.
 */
export function etagMatches(ifNoneMatch: string | null | undefined, etag: string): boolean {
  if (typeof ifNoneMatch !== 'string' || ifNoneMatch.trim() === '') return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, '');
  const want = opaque(etag);
  return ifNoneMatch.split(',').some((tag) => tag.trim() === '*' || opaque(tag) === want);
}

function sortByName(entries: readonly AccountWithAccess[]): AccountWithAccess[] {
  return [...entries].sort(
    (a, b) =>
      a.account.name.localeCompare(b.account.name, 'en', { sensitivity: 'base' }) ||
      a.account.publicId.localeCompare(b.account.publicId),
  );
}
