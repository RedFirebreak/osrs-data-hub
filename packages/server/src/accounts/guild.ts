/**
 * The guild page (handoff §12): members with their visible accounts, the activity feed and simple
 * gains leaderboards (day, week, month).
 */
import { sortSkillsForDisplay, type GuildFeedFilter, type Principal, type Viewer } from '@hub/core';
import { users, type DbOrTx } from '@hub/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { FeedEvent } from '../feed';
import { getGuildFeedFilter } from '../settings/guild-feed';
import { feedForAccounts } from './list-feed';
import {
  loadPresence,
  loadVisibleAccounts,
  toPresence,
  type AccessRestriction,
  type AccountWithAccess,
} from './load';
import { periodStarts } from './periods';
import { computeGains, loadCurrentXp } from './xp';

/** Events in the guild feed before "load more". */
export const GUILD_FEED_EVENTS = 50;
/** Entries per leaderboard. */
export const LEADERBOARD_SIZE = 10;

export type LeaderboardPeriod = 'day' | 'week' | 'month';

export interface Leaderboard {
  skill: string;
  /** Highest gain first; only accounts that gained XP in the period. */
  entries: { publicId: string; name: string; gain: number }[];
}

export interface GuildMember {
  userId: string;
  name: string;
  image: string | null;
  /** online is false unless the viewer may see the account's activity. */
  accounts: { publicId: string; name: string; accountType: number | null; online: boolean }[];
}

export interface GuildOverview {
  members: GuildMember[];
  feed: FeedEvent[];
  /** The admin's guild feed filter (D-81) the feed was read with; live events are checked against it. */
  feedFilter: GuildFeedFilter;
  leaderboards: Record<LeaderboardPeriod, Leaderboard[]>;
}

/**
 * The guild page for `viewer`:
 * - members: active users with at least one account visible to the viewer, sorted by name, each with
 *   those accounts sorted by name. An account appears under its owner; it appears under its
 *   (non-blocked) contributors too only for viewers who may read its contributor list, i.e. the same
 *   rule as the sharing settings (owner, contributors, admins; D-68). A plain member can't learn from
 *   this page who else plays an account;
 * - feed: the newest GUILD_FEED_EVENTS events the viewer may see (listFeed rules, redacted) that
 *   pass the admin's guild feed filter (D-81);
 * - leaderboards: per period (day = since local midnight in `timezone`, week = 7 days, month = 30
 *   days), Overall first and then every skill in grid order that anyone gained XP in, each with the
 *   top LEADERBOARD_SIZE accounts whose stats the viewer may see. Special-world XP is never sampled,
 *   so it never counts.
 * An inactive viewer gets empty lists.
 */
export async function getGuildOverview(
  db: DbOrTx,
  viewer: Viewer,
  opts: { now: Date; timezone?: string },
): Promise<GuildOverview> {
  const visible = await loadVisibleAccounts(db, viewer);
  const members = await loadMembers(db, visible, opts.now);
  const feedFilter = await getGuildFeedFilter(db);
  const feed = await feedForAccounts(db, visible, {
    limit: GUILD_FEED_EVENTS,
    guildFilter: feedFilter,
  });
  const leaderboards = await loadLeaderboards(db, visible, opts);
  return { members, feed, feedFilter, leaderboards };
}

async function loadMembers(
  db: DbOrTx,
  visible: readonly AccountWithAccess[],
  now: Date,
): Promise<GuildMember[]> {
  const accountsByUser = new Map<string, AccountWithAccess[]>();
  for (const entry of visible) {
    // Contributors are listed only to viewers who may read them in the sharing settings (D-68).
    const seesContributors =
      entry.access.relation === 'owner' ||
      entry.access.relation === 'contributor' ||
      entry.access.canManage;
    const players = new Set(
      seesContributors
        ? entry.raw.links.filter((l) => l.blocked === false).map((l) => l.userId)
        : [],
    );
    if (entry.raw.ownerUserId !== null) players.add(entry.raw.ownerUserId);
    for (const userId of players) {
      accountsByUser.set(userId, [...(accountsByUser.get(userId) ?? []), entry]);
    }
  }
  if (accountsByUser.size === 0) return [];
  const memberRows = await db
    .select({ userId: users.id, name: users.name, image: users.image })
    .from(users)
    .where(and(inArray(users.id, [...accountsByUser.keys()]), eq(users.status, 'active')));
  const presence = await loadPresence(
    db,
    visible.filter((e) => e.access.categories.has('activity')).map((e) => e.account.id),
  );
  return memberRows
    .map((member) => ({
      ...member,
      accounts: (accountsByUser.get(member.userId) ?? [])
        .map(({ account }) => {
          const row = presence.get(account.id);
          return {
            publicId: account.publicId,
            name: account.name,
            accountType: account.accountType,
            online: row !== undefined && toPresence(row, now).online,
          };
        })
        .sort((a, b) => byName(a.name, b.name)),
    }))
    .sort((a, b) => byName(a.name, b.name) || a.userId.localeCompare(b.userId));
}

async function loadLeaderboards(
  db: DbOrTx,
  visible: readonly AccountWithAccess[],
  opts: { now: Date; timezone?: string },
): Promise<GuildOverview['leaderboards']> {
  const withStats = visible.filter((e) => e.access.categories.has('stats'));
  const current = await loadCurrentXp(
    db,
    withStats.map((e) => e.account.id),
  );
  const starts = leaderboardStarts(opts.now, opts.timezone);
  const out: GuildOverview['leaderboards'] = { day: [], week: [], month: [] };
  for (const period of ['day', 'week', 'month'] as const) {
    const gains = await computeGains(db, starts[period], current);
    out[period] = rankGains(withStats, gains);
  }
  return out;
}

/**
 * Where each leaderboard period starts: day = local midnight in `timezone` (default UTC), week and
 * month = the last 7 and 30 days (periodStarts).
 */
export function leaderboardStarts(now: Date, timezone?: string): Record<LeaderboardPeriod, Date> {
  const periods = periodStarts(now, timezone);
  return { day: periods.today, week: periods.week, month: periods.month };
}

/**
 * The gains leaderboards of one period, as on the guild page (Overall first, then every skill in grid
 * order that anyone gained XP in, the top LEADERBOARD_SIZE each), over the accounts whose stats the
 * viewer may see, narrowed by `restrict` when given (the public API, D-70; see loadVisibleAccount).
 * Computes only the one period, where the guild page computes all three.
 */
export async function getGainsLeaderboards(
  db: DbOrTx,
  viewer: Principal,
  opts: { period: LeaderboardPeriod; now: Date; timezone?: string },
  restrict?: AccessRestriction,
): Promise<Leaderboard[]> {
  const visible = await loadVisibleAccounts(db, viewer, restrict);
  const withStats = visible.filter((e) => e.access.categories.has('stats'));
  if (withStats.length === 0) return [];
  const current = await loadCurrentXp(
    db,
    withStats.map((e) => e.account.id),
  );
  const from = leaderboardStarts(opts.now, opts.timezone)[opts.period];
  return rankGains(withStats, await computeGains(db, from, current));
}

/** Leaderboards from gains by account: skills with any gain, Overall first, top N each. */
function rankGains(
  accounts: readonly AccountWithAccess[],
  gains: ReadonlyMap<number, ReadonlyMap<string, number>>,
): Leaderboard[] {
  const bySkill = new Map<string, Leaderboard['entries']>();
  for (const { account } of accounts) {
    for (const [skill, gain] of gains.get(account.id) ?? []) {
      if (gain <= 0) continue;
      const entries = bySkill.get(skill) ?? [];
      entries.push({ publicId: account.publicId, name: account.name, gain });
      bySkill.set(skill, entries);
    }
  }
  return sortSkillsForDisplay([...bySkill.keys()]).map((skill) => ({
    skill,
    entries: (bySkill.get(skill) ?? [])
      .sort((a, b) => b.gain - a.gain || byName(a.name, b.name))
      .slice(0, LEADERBOARD_SIZE),
  }));
}

function byName(a: string, b: string): number {
  return a.localeCompare(b, 'en', { sensitivity: 'base' });
}
