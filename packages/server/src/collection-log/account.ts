/**
 * One account's collection log page (D-118): the hiscores' "Collections Logged" as the headline, and
 * the slots the hub has seen, grouped by where they came from. The headline needs `hiscores`, the
 * slots `events` (the category a collection log entry is already shown under); the page needs one of
 * the two, else it is a 404 like any account the viewer may not see.
 */
import { type HiscoreMode, type Principal } from '@hub/core';
import type { DbOrTx } from '@hub/db';
import { leaderboardStarts } from '../accounts/guild';
import { loadVisibleAccount } from '../accounts/load';
import { readKillGains } from '../account-metrics/read';
import { loadHiscoresViews } from '../hiscores/read';
import { readSlots, type CollectionLogSlot } from './read';

/** The hiscores row that counts the whole log. */
export const COLLECTIONS_LOGGED = 'Collections Logged';

export interface CollectionLogTotal {
  /** Slots logged in the game; null when the hiscores don't list the account for it. */
  score: number | null;
  rank: number | null;
  /** Rank on the account's own iron table. */
  modeRank: number | null;
  mode: HiscoreMode;
  /** When the hiscores were read; null before the first good lookup. */
  fetchedAt: string | null;
  /** Its rise over the last 30 days (never counting a baseline reading, as the leaderboards). */
  gained30: number;
}

export interface CollectionLogGroup {
  /** The loot source ("Zulrah"); null for slots that came without a drop. */
  source: string | null;
  /** Newest first. */
  slots: CollectionLogSlot[];
}

export interface AccountCollectionLog {
  account: { publicId: string; name: string };
  /** Null without `hiscores`. */
  total: CollectionLogTotal | null;
  /** Newest first; null without `events`. */
  slots: CollectionLogSlot[] | null;
  /** The slots by source: the most slots first, the ones without a source last. Null without `events`. */
  groups: CollectionLogGroup[] | null;
}

export async function getAccountCollectionLog(
  db: DbOrTx,
  viewer: Principal,
  publicId: string,
  opts: { now: Date; timezone?: string },
): Promise<AccountCollectionLog | null> {
  const entry = await loadVisibleAccount(db, viewer, publicId);
  if (!entry) return null;
  const events = entry.access.categories.has('events');
  const hiscores = entry.access.categories.has('hiscores');
  if (!events && !hiscores) return null;
  const { account } = entry;
  const month = leaderboardStarts(opts.now, opts.timezone).month;
  const [slots, views, gains] = await Promise.all([
    events ? readSlots(db, [account.id]).then((m) => m.get(account.id) ?? []) : null,
    hiscores ? loadHiscoresViews(db, [account]) : null,
    hiscores
      ? readKillGains(db, [account.id], { from: month, to: opts.now }, [COLLECTIONS_LOGGED])
      : [],
  ]);
  let total: CollectionLogTotal | null = null;
  const view = views?.get(account.id);
  if (view) {
    const row = view.activities.find((a) => a.activity === COLLECTIONS_LOGGED);
    total = {
      score: row?.score ?? null,
      rank: row?.rank ?? null,
      modeRank: row?.modeRank ?? null,
      mode: view.mode,
      fetchedAt: view.fetchedAt,
      gained30: gains.reduce((sum, g) => sum + g.kills, 0),
    };
  }
  return {
    account: { publicId: account.publicId, name: account.name },
    total,
    slots,
    groups: slots === null ? null : groupBySource(slots),
  };
}

/** Slots (newest first) by source: the most slots first, then the newest; no source last. */
export function groupBySource(slots: readonly CollectionLogSlot[]): CollectionLogGroup[] {
  const groups = new Map<string, CollectionLogGroup>();
  for (const slot of slots) {
    const key = slot.source?.toLowerCase() ?? '';
    const group = groups.get(key) ?? { source: slot.source, slots: [] };
    groups.set(key, group);
    group.slots.push(slot);
  }
  return [...groups.values()].sort(
    (a, b) =>
      Number(a.source === null) - Number(b.source === null) ||
      b.slots.length - a.slots.length ||
      b.slots[0]!.at.localeCompare(a.slots[0]!.at),
  );
}
