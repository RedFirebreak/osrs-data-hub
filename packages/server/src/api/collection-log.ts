/**
 * GET /accounts/{id}/collection-log and GET /collection-log of the public API (D-131): the collection
 * log pages (D-118) as read models, over the key's accounts and categories (D-70). Both wrap the
 * pages' own models (collection-log/), loaded with the key as the restriction, so a user key sees
 * exactly what its creator's pages show, narrowed to the key, and a service key the guild audience
 * (D-89). The slots need `events`, the hiscores' "Collections Logged" `hiscores`; an account needs
 * one of the two.
 */
import { DAY_MS, floorTo, isHiddenFromGuild, type HiscoreMode } from '@hub/core';
import type { DbOrTx } from '@hub/db';
import type { AccountWithAccess } from '../accounts/load';
import {
  LOOKUP_MAX_LENGTH,
  LOOKUP_MIN_LENGTH,
  getAccountCollectionLog,
  getGuildCollectionLog,
  groupBySource,
  lookupQuery,
  type CollectionLogSlot,
} from '../collection-log';
import { apiRestriction, bulkAccountLimit, loadApiAccount, loadApiAccounts } from './access';
import { ApiError } from './errors';
import type { ApiPrincipal } from './key-auth';
import { assertDate, intParam, listParam } from './params';
import type { ApiAccountRef } from './types';
import { principalTimezone } from './xp';

/** Slots one account response lists by default (newest first). */
export const COLLECTION_LOG_DEFAULT_LIMIT = 100;
/** … and at most. */
export const COLLECTION_LOG_MAX_LIMIT = 500;
/** Board rows the guild response lists by default (most logged first). */
export const GUILD_COLLECTION_LOG_DEFAULT_LIMIT = 100;
/** … and at most. */
export const GUILD_COLLECTION_LOG_MAX_LIMIT = 500;
/** Characters a `source` filter may have. */
export const COLLECTION_LOG_SOURCE_MAX_LENGTH = 64;
export {
  LOOKUP_ITEMS as COLLECTION_LOG_LOOKUP_ITEMS,
  LOOKUP_MAX_LENGTH as COLLECTION_LOG_ITEM_MAX_LENGTH,
  LOOKUP_MIN_LENGTH as COLLECTION_LOG_ITEM_MIN_LENGTH,
} from '../collection-log';

/** One slot the hub saw logged. */
export type ApiCollectionLogSlot = CollectionLogSlot;

export interface ApiCollectionLogTotal {
  /** "Collections Logged" on the hiscores; null when the hiscores don't list the account for it. */
  logged: number | null;
  rank: number | null;
  modeRank: number | null;
  mode: HiscoreMode;
  /** When the hiscores were read; cut to the UTC day without `activity` (D-50). */
  fetchedAt: string | null;
  /** Its rise over the last 30 days. */
  gained30: number;
}

export interface ApiAccountCollectionLog {
  account: ApiAccountRef;
  /** Null without `hiscores`. */
  total: ApiCollectionLogTotal | null;
  /** The slots matching the filters, newest first, at most `limit`; null without `events`. */
  slots: ApiCollectionLogSlot[] | null;
  /** Every slot matching the filters (not only the listed ones) counted by source; null without `events`. */
  groups: { source: string | null; count: number }[] | null;
  /** True when more slots matched than `slots` lists. */
  truncated: boolean;
}

export interface ApiAccountCollectionLogParams {
  /** Only slots from this loot source, case-insensitive ("zulrah"). */
  source?: string;
  /** Only slots logged at or after this time. */
  since?: Date;
  /** 1 to COLLECTION_LOG_MAX_LIMIT; default COLLECTION_LOG_DEFAULT_LIMIT. */
  limit?: number;
}

/**
 * One account's collection log, or null when the key can't see the account or reads neither its
 * `events` nor its `hiscores` (the one 404, D-70; the page's rule).
 */
export async function apiAccountCollectionLog(
  db: DbOrTx,
  principal: ApiPrincipal,
  id: string,
  params: ApiAccountCollectionLogParams = {},
  now: Date = new Date(),
): Promise<ApiAccountCollectionLog | null> {
  const limit = intParam(params.limit, 'limit', {
    min: 1,
    max: COLLECTION_LOG_MAX_LIMIT,
    fallback: COLLECTION_LOG_DEFAULT_LIMIT,
  });
  if (params.since !== undefined) assertDate(params.since, 'since');
  const source = sourceParam(params.source);
  // The key's access to the account, for the `activity` rule on fetched_at; the page's model loads
  // it again through the same restriction and answers null by the same rule.
  const entry = await loadApiAccount(db, principal, id);
  if (!entry) return null;
  const log = await getAccountCollectionLog(db, principal.viewer, id, {
    now,
    timezone: await principalTimezone(db, principal),
    restrict: apiRestriction(principal),
  });
  if (!log) return null;
  const activity = entry.access.categories.has('activity');
  const matched =
    log.slots?.filter(
      (s) =>
        (source === undefined || s.source?.toLowerCase() === source) &&
        (params.since === undefined || s.at >= params.since.toISOString()),
    ) ?? null;
  return {
    account: { id: log.account.publicId, name: log.account.name },
    total:
      log.total === null
        ? null
        : {
            logged: log.total.score,
            rank: log.total.rank,
            modeRank: log.total.modeRank,
            mode: log.total.mode,
            fetchedAt: dayOnlyUnless(activity, log.total.fetchedAt),
            gained30: log.total.gained30,
          },
    slots: matched === null ? null : matched.slice(0, limit),
    groups:
      matched === null
        ? null
        : groupBySource(matched).map((g) => ({ source: g.source, count: g.slots.length })),
    truncated: matched !== null && matched.length > limit,
  };
}

export interface ApiGuildCollectionLogRow {
  account: ApiAccountRef;
  /** "Collections Logged" on the hiscores; null without `hiscores` or when not listed. */
  logged: number | null;
  /** Its rise over the last 30 days; null without `hiscores`. */
  gained30: number | null;
  /** Slots the hub saw; null without `events`. */
  seen: number | null;
  /** The newest of them; null without `events` or before the first. */
  latest: { item: string; itemId: number | null; at: string } | null;
}

export interface ApiGuildCollectionLogItem {
  item: string;
  itemId: number | null;
  /** First logged first. */
  holders: { account: ApiAccountRef; at: string; killCount: number | null }[];
}

export interface ApiGuildCollectionLog {
  /** Most logged first, at most `limit`. */
  board: ApiGuildCollectionLogRow[];
  /** The newest slots across these accounts, newest first. */
  recent: (ApiCollectionLogSlot & { account: ApiAccountRef })[];
  /** The `item` lookup's answer; null without `item`. */
  items: ApiGuildCollectionLogItem[] | null;
  /** How many accounts the slots (and the lookup) were read from: those whose `events` the key reads. */
  searchable: number;
  /** True when the board had more rows than `limit`. */
  truncated: boolean;
}

export interface ApiGuildCollectionLogParams {
  /** "Who has X": a case-insensitive part of an item name, LOOKUP_MIN_LENGTH to LOOKUP_MAX_LENGTH characters. */
  item?: string;
  /** Only these accounts (public ids), at most bulkAccountLimit(principal). */
  accounts?: string[];
  /** Board rows, 1 to GUILD_COLLECTION_LOG_MAX_LIMIT; default GUILD_COLLECTION_LOG_DEFAULT_LIMIT. */
  limit?: number;
}

/**
 * The guild's collection log over every account the key may see, reads `events` or `hiscores` of,
 * and that is not hidden from the guild (D-104), as the guild's log page. `accounts` narrows it to
 * those ids, each of which must be such an account, else ApiError 'not_found' naming it (D-70).
 */
export async function apiGuildCollectionLog(
  db: DbOrTx,
  principal: ApiPrincipal,
  params: ApiGuildCollectionLogParams = {},
  now: Date = new Date(),
): Promise<ApiGuildCollectionLog> {
  const limit = intParam(params.limit, 'limit', {
    min: 1,
    max: GUILD_COLLECTION_LOG_MAX_LIMIT,
    fallback: GUILD_COLLECTION_LOG_DEFAULT_LIMIT,
  });
  const item = itemParam(params.item);
  const named = listParam(params.accounts, 'accounts', bulkAccountLimit(principal));
  const restrict = apiRestriction(principal);
  if (named !== undefined && named.length > 0) {
    const readable = new Map<string, AccountWithAccess>();
    for (const e of await loadApiAccounts(db, principal)) {
      if (logReadable(e)) readable.set(e.account.publicId, e);
    }
    const ids = new Set<number>();
    for (const id of named) {
      const entry = readable.get(id);
      if (!entry) throw new ApiError('not_found', `account ${id.slice(0, 64)} not found`);
      ids.add(entry.account.id);
    }
    restrict.accountIds = ids;
  }
  const log = await getGuildCollectionLog(db, principal.viewer, {
    now,
    timezone: await principalTimezone(db, principal),
    query: item ?? null,
    restrict,
  });
  const ref = (a: { publicId: string; name: string }): ApiAccountRef => ({
    id: a.publicId,
    name: a.name,
  });
  return {
    board: log.board.slice(0, limit).map((r) => ({
      account: ref(r),
      logged: r.logged,
      gained30: r.gained30,
      seen: r.seen,
      latest: r.latest,
    })),
    recent: log.recent.map((s) => ({ ...s, account: ref(s.account) })),
    items:
      log.lookup === null
        ? null
        : log.lookup.items.map((i) => ({
            item: i.item,
            itemId: i.itemId,
            holders: i.holders.map((h) => ({ account: ref(h), at: h.at, killCount: h.killCount })),
          })),
    searchable: log.searchable,
    truncated: log.board.length > limit,
  };
}

/** What the guild log counts an account for: one of its two categories, and not hidden (D-104). */
function logReadable(e: AccountWithAccess): boolean {
  return (
    !isHiddenFromGuild(e.raw) &&
    (e.access.categories.has('events') || e.access.categories.has('hiscores'))
  );
}

/** `iso` as is with `activity`, else cut to its UTC day (D-50, as /accounts/{id}/hiscores). */
function dayOnlyUnless(activity: boolean, iso: string | null): string | null {
  if (iso === null || activity) return iso;
  return floorTo(new Date(iso), DAY_MS).toISOString();
}

/** The `source` filter, lower-cased; ApiError invalid when empty or too long. */
function sourceParam(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '' || text.length > COLLECTION_LOG_SOURCE_MAX_LENGTH) {
    throw new ApiError(
      'invalid',
      `source must be 1 to ${COLLECTION_LOG_SOURCE_MAX_LENGTH} characters`,
    );
  }
  return text.toLowerCase();
}

/** The `item` lookup as the page reads it (lookupQuery); ApiError invalid when too short or long. */
function itemParam(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const raw = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  const query = raw.length > LOOKUP_MAX_LENGTH ? null : lookupQuery(raw);
  if (query === null) {
    throw new ApiError(
      'invalid',
      `item must be ${LOOKUP_MIN_LENGTH} to ${LOOKUP_MAX_LENGTH} characters`,
    );
  }
  return query;
}
