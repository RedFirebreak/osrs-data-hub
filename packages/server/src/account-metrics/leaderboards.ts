/**
 * Guild boss leaderboards (D-110): kills gained per boss over the last 7 or 30 days, among the
 * accounts whose `hiscores` the viewer may read, ranked like the gains leaderboards. Kills are the
 * rises between hiscore readings, never counting a baseline row: an account's first reading, the
 * first after a rename and a score that just appeared add nothing, so nobody's lifetime kill count
 * lands in the week they were first read. An account hidden from the guild (D-104) is never ranked,
 * not even on its owner's own page.
 */
import { activityKind, isHiddenFromGuild, type Principal } from '@hub/core';
import type { DbOrTx } from '@hub/db';
import { loadVisibleAccounts } from '../accounts/load';
import { leaderboardStarts, LEADERBOARD_SIZE } from '../accounts/guild';
import { readKillGains } from './read';

export const BOSS_LEADERBOARD_PERIODS = ['week', 'month'] as const;
export type BossLeaderboardPeriod = (typeof BOSS_LEADERBOARD_PERIODS)[number];

export interface BossLeaderboard {
  activity: string;
  /** Most kills first; only accounts with kills in the period. */
  entries: { publicId: string; name: string; kills: number }[];
}

/**
 * The boss leaderboards of both periods: every boss anyone gained kills of, the most kills overall
 * first, the top LEADERBOARD_SIZE accounts each.
 */
export async function getBossLeaderboards(
  db: DbOrTx,
  viewer: Principal,
  opts: { now: Date; timezone?: string },
): Promise<Record<BossLeaderboardPeriod, BossLeaderboard[]>> {
  const ranked = (await loadVisibleAccounts(db, viewer)).filter(
    (e) => e.access.categories.has('hiscores') && !isHiddenFromGuild(e.raw),
  );
  const out: Record<BossLeaderboardPeriod, BossLeaderboard[]> = { week: [], month: [] };
  if (ranked.length === 0) return out;
  const starts = leaderboardStarts(opts.now, opts.timezone);
  const gains = (
    await readKillGains(
      db,
      ranked.map((e) => e.account.id),
      { from: starts.month, to: opts.now },
    )
  ).filter((g) => activityKind(g.activity) === 'boss');
  const accounts = new Map(ranked.map((e) => [e.account.id, e.account]));
  for (const period of BOSS_LEADERBOARD_PERIODS) {
    const from = starts[period].getTime();
    const byBoss = new Map<string, Map<number, number>>();
    for (const g of gains) {
      if (g.at <= from) continue;
      const row = byBoss.get(g.activity) ?? new Map<number, number>();
      row.set(g.accountId, (row.get(g.accountId) ?? 0) + g.kills);
      byBoss.set(g.activity, row);
    }
    out[period] = [...byBoss.entries()]
      .map(([activity, perAccount]) => ({
        activity,
        total: [...perAccount.values()].reduce((s, k) => s + k, 0),
        entries: [...perAccount.entries()]
          .map(([id, kills]) => ({
            publicId: accounts.get(id)!.publicId,
            name: accounts.get(id)!.name,
            kills,
          }))
          .sort((a, b) => b.kills - a.kills || byName(a.name, b.name))
          .slice(0, LEADERBOARD_SIZE),
      }))
      .sort((a, b) => b.total - a.total || byName(a.activity, b.activity))
      .map(({ activity, entries }) => ({ activity, entries }));
  }
  return out;
}

function byName(a: string, b: string): number {
  return a.localeCompare(b, 'en', { sensitivity: 'base' });
}
