/**
 * An account's hiscores as the hub shows them (the API and the account page, D-105): the main
 * table, with each row's rank on the account's own iron table beside it.
 */
import {
  activityKind,
  hiscoreModeForAccountType,
  readStoredHiscores,
  type ActivityKind,
  type HiscoreMode,
} from '@hub/core';
import { accountHiscores, type DbOrTx, type HiscoreStatus } from '@hub/db';
import { inArray } from 'drizzle-orm';

/** The latest lookup's result, or `pending` before the first. */
export type HiscoresViewStatus = HiscoreStatus | 'pending';

export interface HiscoresSkillView {
  skill: string;
  /** The real level (at most 99; the total level for Overall). */
  level: number;
  xp: number | null;
  rank: number | null;
  /** Rank on the account's own iron table; null for `regular`, or when not listed there. */
  modeRank: number | null;
}

export interface HiscoresActivityView {
  activity: string;
  kind: ActivityKind;
  score: number;
  rank: number | null;
  modeRank: number | null;
}

export interface HiscoresView {
  status: HiscoresViewStatus;
  /** When the tables were read; null while no lookup was ok (then both lists are empty). */
  fetchedAt: string | null;
  mode: HiscoreMode;
  /** Every skill on the main table, Overall first, in Jagex's order. */
  skills: HiscoresSkillView[];
  /** The activities with a score above 0, in Jagex's order. */
  activities: HiscoresActivityView[];
}

type Row = typeof accountHiscores.$inferSelect;

/** The view of each account, by internal id; an account never looked up is `pending`. */
export async function loadHiscoresViews(
  db: DbOrTx,
  accounts: readonly { id: number; accountType: number | null }[],
): Promise<Map<number, HiscoresView>> {
  const rows = new Map<number, Row>();
  if (accounts.length > 0) {
    const found = await db
      .select()
      .from(accountHiscores)
      .where(
        inArray(
          accountHiscores.accountId,
          accounts.map((a) => a.id),
        ),
      );
    for (const r of found) rows.set(r.accountId, r);
  }
  return new Map(
    accounts.map((a) => [a.id, toHiscoresView(rows.get(a.id) ?? null, a.accountType)]),
  );
}

/** One account's row (or none) → its view. */
export function toHiscoresView(row: Row | null, accountType: number | null): HiscoresView {
  const mode = row?.mode ?? hiscoreModeForAccountType(accountType);
  const main = row?.fetchedAt ? readStoredHiscores(row.main) : null;
  if (!row || !main) {
    return { status: row?.status ?? 'pending', fetchedAt: null, mode, skills: [], activities: [] };
  }
  const own = mode === 'regular' ? null : readStoredHiscores(row.modeTable);
  const skillRanks = new Map(own?.skills.map((s) => [s.name, s.rank]) ?? []);
  const activityRanks = new Map(own?.activities.map((a) => [a.name, a.rank]) ?? []);
  return {
    status: row.status,
    fetchedAt: row.fetchedAt!.toISOString(),
    mode,
    skills: main.skills.map((s) => ({
      skill: s.name,
      level: s.level,
      xp: s.xp,
      rank: s.rank,
      modeRank: skillRanks.get(s.name) ?? null,
    })),
    activities: main.activities
      .filter((a) => a.score !== null && a.score > 0)
      .map((a) => ({
        activity: a.name,
        kind: activityKind(a.name),
        score: a.score!,
        rank: a.rank,
        modeRank: activityRanks.get(a.name) ?? null,
      })),
  };
}
