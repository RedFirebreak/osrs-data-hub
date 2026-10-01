/**
 * The public API's leaderboards: GET /leaderboards/gains (handoff §13, for the Discord bot), the
 * guild page's gains leaderboards over the accounts the key may see and read `stats` of; and
 * GET /leaderboards/loot (D-94, for the live map), the most valuable drops of a period over the
 * accounts whose `events` the key may read.
 */
import { events, lootRankedEvent, type DbOrTx } from '@hub/db';
import { and, desc, gte, inArray, lte } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { getGainsLeaderboards, leaderboardStarts, type LeaderboardPeriod } from '../accounts/guild';
import { EVENT_ROW_COLUMNS } from '../feed';
import { apiRestriction, apiViewer } from './access';
import { eventReadableAccounts, toApiEvents, type ApiEvent } from './events';
import type { ApiPrincipal } from './key-auth';
import { enumParam, intParam } from './params';
import { canonicalSkills } from './skills';
import type { ApiAccountRef } from './types';
import { principalTimezone } from './xp';

export const LEADERBOARD_PERIODS = ['day', 'week', 'month'] as const;
export type ApiLeaderboardPeriod = LeaderboardPeriod;

export interface ApiLeaderboardEntry {
  /** 1-based; accounts with equal gains get consecutive ranks (sorted by name). */
  rank: number;
  account: ApiAccountRef;
  /** XP gained in the period. */
  gain: number;
}

export interface ApiLeaderboard {
  skill: string;
  /** Highest gain first, at most LEADERBOARD_SIZE (10); only accounts that gained XP in the period. */
  entries: ApiLeaderboardEntry[];
}

export interface ApiLeaderboards {
  period: ApiLeaderboardPeriod;
  /** Where the period starts: day = local midnight in the key creator's time zone (UTC for a service key); week/month = the last 7/30 days. */
  from: string;
  to: string;
  /**
   * Without `skill`: Overall first, then every skill anyone gained XP in (grid order). With `skill`:
   * exactly that skill's board, with no entries when nobody gained XP in it.
   */
  leaderboards: ApiLeaderboard[];
}

/**
 * Gains leaderboards for one period (default 'day') over the accounts whose `stats` the key may read
 * (D-70). `skill` is matched case-insensitively ("overall" works); an unknown skill or period is
 * ApiError 'invalid'. Special-world XP never counts (it is never sampled).
 */
export async function apiLeaderboardGains(
  db: DbOrTx,
  principal: ApiPrincipal,
  params: { skill?: string; period?: ApiLeaderboardPeriod } = {},
  now: Date = new Date(),
): Promise<ApiLeaderboards> {
  const period = enumParam(params.period, 'period', LEADERBOARD_PERIODS, 'day');
  const [skill] = params.skill === undefined ? [] : await canonicalSkills(db, [params.skill]);
  const timezone = period === 'day' ? await principalTimezone(db, principal) : undefined;
  const boards = await getGainsLeaderboards(
    db,
    apiViewer(principal),
    { period, now, timezone },
    apiRestriction(principal),
  );
  const selected =
    skill === undefined
      ? boards
      : [boards.find((b) => b.skill === skill) ?? { skill, entries: [] }];
  return {
    period,
    from: leaderboardStarts(now, timezone)[period].toISOString(),
    to: now.toISOString(),
    leaderboards: selected.map((board) => ({
      skill: board.skill,
      entries: board.entries.map((e, i) => ({
        rank: i + 1,
        account: { id: e.publicId, name: e.name },
        gain: e.gain,
      })),
    })),
  };
}

export const LOOT_LEADERBOARD_DEFAULT_LIMIT = 10;
export const LOOT_LEADERBOARD_MAX_LIMIT = 50;

export interface ApiLootLeaderboardEntry {
  /** 1-based; drops of equal value are ranked newest first. */
  rank: number;
  /** The drop exactly as /events serves it, redacted the same way. */
  event: ApiEvent;
}

export interface ApiLootLeaderboard {
  period: ApiLeaderboardPeriod;
  /** Where the period starts, as for the gains leaderboards (see ApiLeaderboards.from). */
  from: string;
  to: string;
  /** Highest `valueGp` first, at most `limit`; empty when no drop (or no readable account) qualifies. */
  entries: ApiLootLeaderboardEntry[];
}

/**
 * The most valuable drops of one period (default 'day', like the gains leaderboards) over the
 * accounts whose `events` the key may read (D-70, D-94): `loot` and `pk_loot` events with a value
 * that occurred in [from, now], never on a special world, highest value first (then newest). Each
 * event is the /events one, redacted for the key's categories on its account. `limit` defaults to
 * 10, at most 50; an unknown period or a bad limit is ApiError 'invalid'. The guild feed filter
 * (D-81) doesn't apply, as for the rest of the API.
 */
export async function apiLootLeaderboard(
  db: DbOrTx,
  principal: ApiPrincipal,
  params: { period?: ApiLeaderboardPeriod; limit?: number } = {},
  now: Date = new Date(),
): Promise<ApiLootLeaderboard> {
  const period = enumParam(params.period, 'period', LEADERBOARD_PERIODS, 'day');
  const limit = intParam(params.limit, 'limit', {
    min: 1,
    max: LOOT_LEADERBOARD_MAX_LIMIT,
    fallback: LOOT_LEADERBOARD_DEFAULT_LIMIT,
  });
  const timezone = period === 'day' ? await principalTimezone(db, principal) : undefined;
  const from = leaderboardStarts(now, timezone)[period];
  const head = { period, from: from.toISOString(), to: now.toISOString() };

  const accounts = await eventReadableAccounts(db, principal, undefined);
  if (accounts.size === 0) return { ...head, entries: [] };
  // Rank on events_loot_rank_idx alone (an index-only scan over the period's drops), then read the
  // full rows of the top `limit` only: ranking over the rows themselves fetched every drop's jsonb.
  const ranked = alias(events, 'ranked');
  const top = db
    .select({ seq: ranked.seq })
    .from(ranked)
    .where(
      and(
        inArray(ranked.accountId, [...accounts.keys()]),
        gte(ranked.occurredAt, from),
        lte(ranked.occurredAt, now),
        lootRankedEvent(ranked),
      ),
    )
    .orderBy(desc(ranked.valueGp), desc(ranked.occurredAt), desc(ranked.seq))
    .limit(limit);
  const rows = await db
    .select(EVENT_ROW_COLUMNS)
    .from(events)
    .where(inArray(events.seq, top))
    .orderBy(desc(events.valueGp), desc(events.occurredAt), desc(events.seq));
  return {
    ...head,
    entries: toApiEvents(rows, accounts).map((event, i) => ({ rank: i + 1, event })),
  };
}
