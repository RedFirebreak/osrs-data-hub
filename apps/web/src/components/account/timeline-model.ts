/**
 * Pure helpers behind EventTimeline: which live events belong in a timeline, merging pages and live
 * events without duplicates, and the "load more" request. Client-safe (type-only imports from
 * @hub/server; @hub/core is side-effect free, D-67), tested.
 */
import { inGuildFeed, type GuildFeedFilter } from '@hub/core';
import type { FeedEvent } from '@hub/server';

export interface TimelineFilter {
  /** Only this account's events (the account page); undefined = every visible account (guild). */
  accountPublicId?: string;
  /** Only these stored types; empty = all types. */
  types: readonly string[];
  /** The guild feed's admin filter (D-81), which the server applied to the pages too. */
  guildFilter?: GuildFeedFilter;
}

/** Whether a live event belongs in a timeline with this filter. */
export function matchesFilter(event: FeedEvent, filter: TimelineFilter): boolean {
  if (filter.accountPublicId !== undefined && event.account.publicId !== filter.accountPublicId) {
    return false;
  }
  if (filter.guildFilter !== undefined && !inGuildFeed(event, filter.guildFilter)) return false;
  return filter.types.length === 0 || filter.types.includes(event.type);
}

/**
 * `current` plus `incoming`, each event once (by id; the copy already shown wins), newest first by
 * seq, the feed's order. Returns `current` itself when nothing new was added.
 */
export function mergeEvents(
  current: readonly FeedEvent[],
  incoming: readonly FeedEvent[],
): readonly FeedEvent[] {
  const seen = new Set(current.map((e) => e.id));
  const added = incoming.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
  if (added.length === 0) return current;
  return [...current, ...added].sort((a, b) => b.seq - a.seq);
}

/**
 * The GET /api/app/feed URL for a page of the timeline: `before` = the oldest seq shown (omitted for
 * the first page).
 */
export function feedUrl(filter: TimelineFilter, opts: { before?: number; limit: number }): string {
  const q = new URLSearchParams();
  if (filter.accountPublicId !== undefined) q.set('account', filter.accountPublicId);
  if (filter.types.length > 0) q.set('types', filter.types.join(','));
  if (opts.before !== undefined) q.set('before', String(opts.before));
  q.set('limit', String(opts.limit));
  return `/api/app/feed?${q.toString()}`;
}

/** The seq to continue "load more" from: the smallest seq shown, or undefined for none. */
export function oldestSeq(events: readonly FeedEvent[]): number | undefined {
  let min: number | undefined;
  for (const e of events) if (min === undefined || e.seq < min) min = e.seq;
  return min;
}
