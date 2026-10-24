/**
 * The guild's collection log (D-118): a board of every account the viewer may see the log of, the
 * newest slots across the guild, and the lookup "who has X". Each account adds only what the viewer
 * may read of it: the hiscores' "Collections Logged" and its rise over 30 days need `hiscores`, the
 * slots the hub saw need `events`. An account hidden from the guild (D-104) is never on the board,
 * as on the other guild leaderboards.
 */
import { isHiddenFromGuild, type Principal } from '@hub/core';
import type { DbOrTx } from '@hub/db';
import { loadVisibleAccounts, type AccountWithAccess } from '../accounts/load';
import { leaderboardStarts } from '../accounts/guild';
import { readKillGains } from '../account-metrics/read';
import { loadHiscoresViews } from '../hiscores/read';
import { COLLECTIONS_LOGGED } from './account';
import { readSlots, type CollectionLogSlot } from './read';

/** Newest slots listed across the guild. */
export const GUILD_RECENT_SLOTS = 12;
/** Items a lookup lists at most. */
export const LOOKUP_ITEMS = 30;
/** A lookup needs at least this many characters. */
export const LOOKUP_MIN_LENGTH = 2;
/** And at most this many. */
export const LOOKUP_MAX_LENGTH = 64;

export interface GuildLogAccount {
  publicId: string;
  name: string;
}

export interface GuildLogRow extends GuildLogAccount {
  /** "Collections Logged" on the hiscores; null without `hiscores` or when not listed. */
  logged: number | null;
  /** Its rise over the last 30 days; null without `hiscores`. */
  gained30: number | null;
  /** Slots the hub saw; null without `events`. */
  seen: number | null;
  /** The newest of them; null without `events` or before the first. */
  latest: Pick<CollectionLogSlot, 'item' | 'itemId' | 'at'> | null;
}

export interface GuildLogSlot extends CollectionLogSlot {
  account: GuildLogAccount;
}

export interface GuildLogLookupItem {
  item: string;
  itemId: number | null;
  /** Who logged it, first logged first. */
  holders: (GuildLogAccount & Pick<CollectionLogSlot, 'at' | 'killCount'>)[];
}

export interface GuildCollectionLog {
  /** Most logged first (the hiscores' count, else the slots seen). */
  board: GuildLogRow[];
  /** Newest first. */
  recent: GuildLogSlot[];
  /** How many accounts the lookup searched (those whose `events` the viewer may read). */
  searchable: number;
  /** The lookup's answer; null without a (long enough) query. */
  lookup: { query: string; items: GuildLogLookupItem[] } | null;
}

/** The query as the lookup uses it: trimmed, null when too short, cut when too long. */
export function lookupQuery(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const q = raw.trim().replace(/\s+/g, ' ').slice(0, LOOKUP_MAX_LENGTH);
  return q.length >= LOOKUP_MIN_LENGTH ? q : null;
}

export async function getGuildCollectionLog(
  db: DbOrTx,
  viewer: Principal,
  opts: { now: Date; timezone?: string; query?: string | null },
): Promise<GuildCollectionLog> {
  const visible = (await loadVisibleAccounts(db, viewer)).filter(
    (e) =>
      !isHiddenFromGuild(e.raw) &&
      (e.access.categories.has('events') || e.access.categories.has('hiscores')),
  );
  const withEvents = visible.filter((e) => e.access.categories.has('events'));
  const withHiscores = visible.filter((e) => e.access.categories.has('hiscores'));
  const query = lookupQuery(opts.query ?? null);
  const month = leaderboardStarts(opts.now, opts.timezone).month;
  const [slots, views, gains, found] = await Promise.all([
    readSlots(
      db,
      withEvents.map((e) => e.account.id),
    ),
    loadHiscoresViews(
      db,
      withHiscores.map((e) => e.account),
    ),
    readKillGains(
      db,
      withHiscores.map((e) => e.account.id),
      { from: month, to: opts.now },
      [COLLECTIONS_LOGGED],
    ),
    query === null
      ? null
      : readSlots(
          db,
          withEvents.map((e) => e.account.id),
          { itemLike: query },
        ),
  ]);
  const gained = new Map<number, number>();
  for (const g of gains) gained.set(g.accountId, (gained.get(g.accountId) ?? 0) + g.kills);

  const board: GuildLogRow[] = visible.map((e) => {
    const events = e.access.categories.has('events');
    const hiscores = e.access.categories.has('hiscores');
    const own = events ? (slots.get(e.account.id) ?? []) : null;
    const view = hiscores ? views.get(e.account.id) : undefined;
    const newest = own?.[0];
    return {
      ...ref(e),
      logged: view?.activities.find((a) => a.activity === COLLECTIONS_LOGGED)?.score ?? null,
      gained30: hiscores ? (gained.get(e.account.id) ?? 0) : null,
      seen: own === null ? null : own.length,
      latest: newest ? { item: newest.item, itemId: newest.itemId, at: newest.at } : null,
    };
  });
  board.sort(
    (a, b) =>
      (b.logged ?? -1) - (a.logged ?? -1) ||
      (b.seen ?? -1) - (a.seen ?? -1) ||
      byName(a.name, b.name),
  );
  // Accounts with nothing to show (no hiscores row, no slot) are left off the board.
  const shown = board.filter((r) => r.logged !== null || (r.seen ?? 0) > 0);

  const byId = new Map(withEvents.map((e) => [e.account.id, e]));
  const recent: GuildLogSlot[] = [];
  for (const [id, list] of slots) {
    for (const slot of list.slice(0, GUILD_RECENT_SLOTS)) {
      recent.push({ ...slot, account: ref(byId.get(id)!) });
    }
  }
  recent.sort((a, b) => b.at.localeCompare(a.at) || byName(a.account.name, b.account.name));

  return {
    board: shown,
    recent: recent.slice(0, GUILD_RECENT_SLOTS),
    searchable: withEvents.length,
    lookup: query === null ? null : { query, items: toLookupItems(found!, byId) },
  };
}

function toLookupItems(
  found: Map<number, CollectionLogSlot[]>,
  accounts: Map<number, AccountWithAccess>,
): GuildLogLookupItem[] {
  const items = new Map<string, GuildLogLookupItem>();
  for (const [id, list] of found) {
    const account = ref(accounts.get(id)!);
    for (const slot of list) {
      const key = slot.item.toLowerCase();
      const item = items.get(key) ?? { item: slot.item, itemId: slot.itemId, holders: [] };
      items.set(key, item);
      item.itemId ??= slot.itemId;
      item.holders.push({ ...account, at: slot.at, killCount: slot.killCount });
    }
  }
  for (const item of items.values()) {
    item.holders.sort((a, b) => a.at.localeCompare(b.at) || byName(a.name, b.name));
  }
  return [...items.values()]
    .sort((a, b) => b.holders.length - a.holders.length || byName(a.item, b.item))
    .slice(0, LOOKUP_ITEMS);
}

function ref(e: AccountWithAccess): GuildLogAccount {
  return { publicId: e.account.publicId, name: e.account.name };
}

function byName(a: string, b: string): number {
  return a.localeCompare(b, 'en', { sensitivity: 'base' });
}
