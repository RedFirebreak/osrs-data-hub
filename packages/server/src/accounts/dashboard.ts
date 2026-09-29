/**
 * The dashboard (handoff §12): a card per account the viewer owns or contributes to, and the guild's
 * "online now" strip.
 */
import { OVERALL, totalLevel, type Viewer } from '@hub/core';
import type { DbOrTx } from '@hub/db';
import type { FeedEvent } from '../feed';
import {
  loadPresence,
  loadRecentEventRows,
  loadVisibleAccounts,
  toFeedEvents,
  toPresence,
  type AccountWithAccess,
  type Presence,
  type PresenceRow,
} from './load';
import { periodStarts } from './periods';
import { sectionOf, type Section } from './sections';
import { computeGains, loadCurrentSkills, xpBySkill, type XpByAccount } from './xp';

/** Events per dashboard card. */
export const CARD_EVENTS = 5;

export interface AccountCard {
  publicId: string;
  name: string;
  accountType: number | null;
  relation: 'owner' | 'contributor';
  presence: Section<Presence>;
  /** Real total level, Σ min(level, 99) (D-44); null when the plugin never sent stats. */
  totalLevel: number | null;
  overallXp: number | null;
  /** Overall XP gained since local midnight and over the last 7 days; null without stats. */
  gains: { today: number | null; week: number | null };
  /** The newest events, up to CARD_EVENTS, newest first. */
  recentEvents: FeedEvent[];
}

export interface OnlineEntry {
  publicId: string;
  name: string;
  accountType: number | null;
  world: number | null;
  specialWorld: boolean;
  lastSeen: string;
}

export interface Dashboard {
  accounts: AccountCard[];
  onlineNow: OnlineEntry[];
}

/**
 * The viewer's dashboard:
 * - accounts: every visible account the viewer owns or contributes to through a non-blocked link
 *   (resolveAccess relation owner/contributor; hidden accounts only for admins), most recently seen
 *   first. Owners and contributors see every category, so the cards are complete.
 * - onlineNow: every visible account whose activity the viewer may see and that is online now
 *   (isOnline), the viewer's own included, sorted by name.
 * An inactive viewer gets an empty dashboard. "Today" is local midnight in `timezone` (default UTC).
 */
export async function getDashboard(
  db: DbOrTx,
  viewer: Viewer,
  opts: { now: Date; timezone?: string },
): Promise<Dashboard> {
  const visible = await loadVisibleAccounts(db, viewer);
  const withActivity = visible.filter((e) => e.access.categories.has('activity'));
  const presence = await loadPresence(
    db,
    withActivity.map((e) => e.account.id),
  );
  const mine = visible
    .filter((e) => e.access.relation === 'owner' || e.access.relation === 'contributor')
    .sort((a, b) => b.account.lastSeen.getTime() - a.account.lastSeen.getTime());
  return {
    accounts: await buildCards(db, mine, presence, opts),
    onlineNow: onlineEntries(withActivity, presence, opts.now),
  };
}

function onlineEntries(
  withActivity: readonly AccountWithAccess[],
  presence: ReadonlyMap<number, PresenceRow>,
  now: Date,
): OnlineEntry[] {
  const out: OnlineEntry[] = [];
  for (const { account } of withActivity) {
    const row = presence.get(account.id);
    if (!row || !toPresence(row, now).online) continue;
    out.push({
      publicId: account.publicId,
      name: account.name,
      accountType: account.accountType,
      world: row.world,
      specialWorld: row.specialWorld,
      lastSeen: row.lastSeen.toISOString(),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

async function buildCards(
  db: DbOrTx,
  mine: readonly AccountWithAccess[],
  presence: ReadonlyMap<number, PresenceRow>,
  opts: { now: Date; timezone?: string },
): Promise<AccountCard[]> {
  if (mine.length === 0) return [];
  const idsWith = (category: 'stats' | 'events') =>
    mine.filter((e) => e.access.categories.has(category)).map((e) => e.account.id);
  const skills = await loadCurrentSkills(db, idsWith('stats'));
  const current: XpByAccount = new Map();
  for (const [id, parsed] of skills) current.set(id, xpBySkill(parsed));
  const periods = periodStarts(opts.now, opts.timezone);
  const today = await computeGains(db, periods.today, current);
  const week = await computeGains(db, periods.week, current);
  const eventRows = await loadRecentEventRows(db, idsWith('events'), CARD_EVENTS);

  return mine.map((entry): AccountCard => {
    const { account, access } = entry;
    const parsed = skills.get(account.id);
    const overall = current.get(account.id)?.get(OVERALL) ?? null;
    const row = presence.get(account.id);
    return {
      publicId: account.publicId,
      name: account.name,
      accountType: account.accountType,
      relation: access.relation === 'owner' ? 'owner' : 'contributor',
      presence: sectionOf(access.categories.has('activity'), row?.lastSeen, () =>
        toPresence(row as PresenceRow, opts.now),
      ),
      totalLevel: parsed === undefined ? null : totalLevel(parsed),
      overallXp: overall,
      gains: {
        today: overall === null ? null : (today.get(account.id)?.get(OVERALL) ?? 0),
        week: overall === null ? null : (week.get(account.id)?.get(OVERALL) ?? 0),
      },
      recentEvents: toFeedEvents(eventRows.get(account.id) ?? [], entry),
    };
  });
}
