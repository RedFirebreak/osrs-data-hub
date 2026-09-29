/**
 * The guild page (handoff §12): members with their visible accounts, the activity feed and simple
 * gains leaderboards (day, week, month).
 */
import { sortSkillsForDisplay, type Viewer } from '@hub/core';
import { users, type DbOrTx } from '@hub/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { FeedEvent } from '../feed';
import { feedForAccounts } from './list-feed';
import { loadPresence, loadVisibleAccounts, toPresence, type AccountWithAccess } from './load';
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
  leaderboards: Record<LeaderboardPeriod, Leaderboard[]>;
}

/**
 * The guild page for `viewer`:
 * - members: active users with at least one account visible to the viewer (an account is a member's
 *   when they own it or have a non-blocked link to it, so a shared account appears under each of its
 *   players), sorted by name, each with those accounts sorted by name;
 * - feed: the newest GUILD_FEED_EVENTS events the viewer may see (listFeed rules, redacted);
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
  const feed = await feedForAccounts(db, visible, { limit: GUILD_FEED_EVENTS });
  const leaderboards = await loadLeaderboards(db, visible, opts);
  return { members, feed, leaderboards };
}

async function loadMembers(
  db: DbOrTx,
  visible: readonly AccountWithAccess[],
  now: Date,
): Promise<GuildMember[]> {
  const accountsByUser = new Map<string, AccountWithAccess[]>();
  for (const entry of visible) {
    const players = new Set(
      entry.raw.links.filter((l) => l.blocked === false).map((l) => l.userId),
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
  const periods = periodStarts(opts.now, opts.timezone);
  const starts: Record<LeaderboardPeriod, Date> = {
    day: periods.today,
    week: periods.week,
    month: periods.month,
  };
  const out: GuildOverview['leaderboards'] = { day: [], week: [], month: [] };
  for (const period of ['day', 'week', 'month'] as const) {
    const gains = await computeGains(db, starts[period], current);
    out[period] = rankGains(withStats, gains);
  }
  return out;
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
