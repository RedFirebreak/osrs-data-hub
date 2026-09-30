/**
 * GET /leaderboards/gains of the public API (handoff §13, for the Discord bot): the guild page's
 * gains leaderboards over the accounts the key may see and read `stats` of.
 */
import type { DbOrTx } from '@hub/db';
import {
  LEADERBOARD_SIZE,
  getGainsLeaderboards,
  leaderboardStarts,
  type LeaderboardPeriod,
} from '../accounts/guild';
import { apiRestriction, apiViewer } from './access';
import type { ApiPrincipal } from './keys';
import { enumParam } from './params';
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
  /** Highest gain first, at most 10; only accounts that gained XP in the period. */
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
      entries: board.entries.slice(0, LEADERBOARD_SIZE).map((e, i) => ({
        rank: i + 1,
        account: { id: e.publicId, name: e.name },
        gain: e.gain,
      })),
    })),
  };
}
