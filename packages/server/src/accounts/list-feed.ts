/**
 * The events feed (dashboard, account timeline, guild activity): newest first by seq, only accounts
 * whose `events` category the viewer may see, every event redacted for the viewer (toFeedEvent).
 * Special-world events are included and flagged (FeedEvent.specialWorld).
 */
import type { Viewer } from '@hub/core';
import { events, type DbOrTx } from '@hub/db';
import { and, desc, inArray, lt } from 'drizzle-orm';
import type { FeedEvent } from '../feed';
import {
  loadVisibleAccount,
  loadVisibleAccounts,
  toFeedEvents,
  type AccountWithAccess,
} from './load';

export const FEED_DEFAULT_LIMIT = 50;
export const FEED_MAX_LIMIT = 200;
/** Longest accepted type filter list (there are about a dozen known types). */
const MAX_TYPE_FILTERS = 64;

export interface ListFeedOptions {
  /** Only this account's events. */
  accountPublicId?: string;
  /** Only these stored types (lower_snake, e.g. 'loot'); an empty list means no filter. */
  types?: string[];
  /** Only events with seq < beforeSeq: "load more" continues from the last event shown. */
  beforeSeq?: number;
  /** Default 50, clamped to 1…200. */
  limit?: number;
}

/**
 * The viewer's feed, newest first by seq. An account that isn't visible, or whose events category the
 * viewer lacks, contributes nothing (an unknown or invisible `accountPublicId` gives []).
 *
 * seq is taken at insert, not commit (DB-4): a slow ingest transaction can commit an event whose seq is
 * lower than one already shown, so a page fetched with `beforeSeq` may skip it. That's acceptable for a
 * browsing feed (the live stream delivers it, and a reload shows it); cursor consumers that must see
 * every row use the live replay instead.
 */
export async function listFeed(
  db: DbOrTx,
  viewer: Viewer,
  opts: ListFeedOptions = {},
): Promise<FeedEvent[]> {
  let accounts: AccountWithAccess[];
  if (opts.accountPublicId !== undefined) {
    const found = await loadVisibleAccount(db, viewer, opts.accountPublicId);
    accounts = found ? [found] : [];
  } else {
    accounts = await loadVisibleAccounts(db, viewer);
  }
  return feedForAccounts(db, accounts, opts);
}

/** listFeed over already-loaded accounts (the guild overview reuses its own list). */
export async function feedForAccounts(
  db: DbOrTx,
  accounts: readonly AccountWithAccess[],
  opts: Omit<ListFeedOptions, 'accountPublicId'>,
): Promise<FeedEvent[]> {
  const byId = new Map<number, AccountWithAccess>();
  for (const entry of accounts) {
    if (entry.access.categories.has('events')) byId.set(entry.account.id, entry);
  }
  if (byId.size === 0) return [];
  const types = (opts.types ?? []).filter((t) => typeof t === 'string').slice(0, MAX_TYPE_FILTERS);
  const beforeSeq =
    opts.beforeSeq !== undefined && Number.isSafeInteger(opts.beforeSeq) ? opts.beforeSeq : null;
  const rows = await db
    .select({
      id: events.id,
      seq: events.seq,
      accountId: events.accountId,
      type: events.type,
      occurredAt: events.occurredAt,
      receivedAt: events.receivedAt,
      valueGp: events.valueGp,
      itemId: events.itemId,
      npcId: events.npcId,
      skill: events.skill,
      level: events.level,
      tier: events.tier,
      points: events.points,
      specialWorld: events.specialWorld,
      data: events.data,
    })
    .from(events)
    .where(
      and(
        inArray(events.accountId, [...byId.keys()]),
        types.length > 0 ? inArray(events.type, types) : undefined,
        beforeSeq !== null ? lt(events.seq, beforeSeq) : undefined,
      ),
    )
    .orderBy(desc(events.seq))
    .limit(clampLimit(opts.limit));
  return rows.flatMap((row) => {
    const entry = byId.get(row.accountId);
    return entry ? toFeedEvents([row], entry) : [];
  });
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return FEED_DEFAULT_LIMIT;
  return Math.min(FEED_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}
