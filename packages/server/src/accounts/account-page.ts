/**
 * The account page (handoff §12): header, presence, vitals, live location, skills with gains,
 * equipment, inventory and recent events, each section gated by its sharing category (handoff §10)
 * and shown as "not shared" when the plugin never sent it (D-4).
 */
import {
  LOCATION_STALE_MS,
  OVERALL,
  itemsValue,
  overallXp,
  realLevel,
  sortSkillsForDisplay,
  totalLevel,
  type Category,
  type ItemData,
  type Viewer,
} from '@hub/core';
import { accountNames, latestState, users, type DbOrTx } from '@hub/db';
import { and, desc, eq, ne } from 'drizzle-orm';
import type { FeedEvent } from '../feed';
import { DEFAULT_TIMEZONE } from '../settings/user-settings';
import {
  loadRecentEventRows,
  loadVisibleAccount,
  toFeedEvents,
  toPresence,
  type AccountWithAccess,
  type Presence,
} from './load';
import { periodStarts, startOfLocalDay, type PeriodStarts } from './periods';
import { latestOf, restampSection, sectionOf, type Section } from './sections';
import { computeGains, parseSkills, xpBySkill } from './xp';

/** Events in the page's timeline before "load more" (listFeed with beforeSeq). */
export const PAGE_EVENTS = 20;
/** Previous names listed in the header. */
const MAX_PREVIOUS_NAMES = 50;

export interface SkillRow {
  skill: string;
  /** As sent: virtual above 99 (PLUGIN-9). For Overall, the real total level (D-44). */
  level: number;
  /** min(level, 99); for Overall the real total level. */
  realLevel: number;
  xp: number;
  gains: { day: number; week: number; month: number; year: number };
}

export interface Vitals {
  hp: { current: number; max: number } | null;
  prayer: { current: number; max: number } | null;
  spellbook: string | null;
}

export interface LiveLocation {
  x: number;
  y: number;
  plane: number;
  isOnBoat: boolean;
  /** No location update for longer than LOCATION_STALE_MS (D-18: only location expires). */
  stale: boolean;
}

export interface AccountHeader {
  publicId: string;
  name: string;
  accountType: number | null;
  firstSeen: string;
  /**
   * When the hub last heard from the account; null unless the viewer may see `activity` (a last-seen
   * time is presence, and the owner may have made that private).
   */
  lastSeen: string | null;
  /** Earlier names, most recent first (the current name excluded). */
  previousNames: { name: string; lastSeen: string }[];
  owner: { userId: string; name: string; image: string | null } | null;
  relation: 'owner' | 'contributor' | 'member' | 'none';
  canManage: boolean;
  /** Hidden (owner offboarded without a transfer); only admins get here for a hidden account. */
  hidden: boolean;
}

/**
 * Every section follows Section's three states. A shared section's `updatedAt` is when the hub last
 * received it, except for viewers without `activity`: for them skills, equipment and inventory carry
 * only the day (local midnight in the viewer's time zone), since the plugin sends stats with every
 * periodic update and the exact time would be the last-seen time the owner hid (D-50). The live
 * location keeps its time: a live position is presence by nature, and whoever may see it may see that.
 */
export interface AccountPage {
  account: AccountHeader;
  /** activity */
  presence: Section<Presence>;
  /** activity */
  vitals: Section<Vitals>;
  /** location_live */
  location: Section<LiveLocation>;
  /** stats: rows in the in-game grid order with Overall first. */
  skills: Section<{ totalLevel: number; overallXp: number; rows: SkillRow[] }>;
  equipment: Section<{ items: ItemData[] }>;
  /** `value` is the inventory's GE value (Σ gePrice × quantity). */
  inventory: Section<{ items: ItemData[]; value: number }>;
  /** events: the newest PAGE_EVENTS, redacted; "not shared" when the account has no events at all. */
  recentEvents: Section<FeedEvent[]>;
}

type LatestRow = typeof latestState.$inferSelect;

/**
 * The account page for `publicId`, or null when the viewer may not see the account at all (the route
 * answers 404). Each section follows Section's three states; data of a category the viewer lacks is
 * never loaded into the result. Gains periods use the viewer's `timezone` (default UTC) for "day",
 * and so does the day-only `updatedAt` of viewers without `activity` (see AccountPage).
 */
export async function getAccountPage(
  db: DbOrTx,
  viewer: Viewer,
  publicId: string,
  opts: { now: Date; timezone?: string },
): Promise<AccountPage | null> {
  const entry = await loadVisibleAccount(db, viewer, publicId);
  if (!entry) return null;
  const { account, access } = entry;
  const can = (category: Category) => access.categories.has(category);
  const timezone = opts.timezone ?? DEFAULT_TIMEZONE;
  // See AccountPage: without activity, the time of the last payload is withheld (D-50).
  const dayOnly = <T>(section: Section<T>): Section<T> =>
    can('activity') ? section : restampSection(section, (at) => startOfLocalDay(at, timezone));

  // Sequential on purpose: `db` may be a transaction, where concurrent queries on one client are
  // deprecated in pg 8 and removed in pg 9.
  const [state] = await db.select().from(latestState).where(eq(latestState.accountId, account.id));
  const header = await loadHeader(db, entry);
  const skills: AccountPage['skills'] = can('stats')
    ? await skillsSection(db, account.id, state, periodStarts(opts.now, timezone))
    : { visible: false };
  const recentEvents: AccountPage['recentEvents'] = can('events')
    ? await eventsSection(db, entry)
    : { visible: false };

  return {
    account: { ...header, lastSeen: can('activity') ? account.lastSeen.toISOString() : null },
    presence: sectionOf(can('activity'), state?.lastSeen, () =>
      toPresence(state as LatestRow, opts.now),
    ),
    vitals: sectionOf(
      can('activity'),
      state && latestOf(state.healthUpdatedAt, state.prayerUpdatedAt, state.spellbookUpdatedAt),
      () => vitalsOf(state as LatestRow),
    ),
    location: locationSection(can('location_live'), state, opts.now),
    skills: dayOnly(skills),
    equipment: dayOnly(
      itemsSection(can('equipment'), state?.equipment, state?.equipmentUpdatedAt, (items) => ({
        items,
      })),
    ),
    inventory: dayOnly(
      itemsSection(can('inventory'), state?.inventory, state?.inventoryUpdatedAt, (items) => ({
        items,
        value: itemsValue(items) ?? 0,
      })),
    ),
    recentEvents,
  };
}

async function loadHeader(
  db: DbOrTx,
  { account, access }: AccountWithAccess,
): Promise<Omit<AccountHeader, 'lastSeen'>> {
  const ownerRows =
    account.ownerUserId === null
      ? []
      : await db
          .select({ userId: users.id, name: users.name, image: users.image })
          .from(users)
          .where(eq(users.id, account.ownerUserId));
  const names = await db
    .select({ name: accountNames.name, lastSeen: accountNames.lastSeen })
    .from(accountNames)
    .where(and(eq(accountNames.accountId, account.id), ne(accountNames.name, account.name)))
    .orderBy(desc(accountNames.lastSeen))
    .limit(MAX_PREVIOUS_NAMES);
  return {
    publicId: account.publicId,
    name: account.name,
    accountType: account.accountType,
    firstSeen: account.firstSeen.toISOString(),
    previousNames: names.map((n) => ({ name: n.name, lastSeen: n.lastSeen.toISOString() })),
    owner: ownerRows[0] ?? null,
    relation: access.relation,
    canManage: access.canManage,
    hidden: account.status === 'hidden',
  };
}

function vitalsOf(state: LatestRow): Vitals {
  const meter = (at: Date | null, current: number | null, max: number | null) =>
    at !== null && current !== null && max !== null ? { current, max } : null;
  return {
    hp: meter(state.healthUpdatedAt, state.hpCurrent, state.hpMax),
    prayer: meter(state.prayerUpdatedAt, state.prayerCurrent, state.prayerMax),
    spellbook: state.spellbookUpdatedAt === null ? null : state.spellbook,
  };
}

function locationSection(
  visible: boolean,
  state: LatestRow | undefined,
  now: Date,
): Section<LiveLocation> {
  const at = state?.locationUpdatedAt ?? null;
  const loc = visible && at !== null ? parseLocation(state?.location) : null;
  // A stored value that isn't a location can't be shown: treat it as never sent.
  return sectionOf(visible, loc === null ? null : at, () => ({
    ...(loc as Omit<LiveLocation, 'stale'>),
    stale: now.getTime() - (at as Date).getTime() > LOCATION_STALE_MS,
  }));
}

function parseLocation(value: unknown): Omit<LiveLocation, 'stale'> | null {
  if (typeof value !== 'object' || value === null) return null;
  const { x, y, plane, isOnBoat } = value as Record<string, unknown>;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof plane !== 'number') return null;
  return { x, y, plane, isOnBoat: isOnBoat === true };
}

function itemsSection<T>(
  visible: boolean,
  items: unknown,
  updatedAt: Date | null | undefined,
  build: (items: ItemData[]) => T,
): Section<T> {
  // Stored from a validated section (ingest); a non-array can only come from a manual edit.
  const list = Array.isArray(items) ? (items as ItemData[]) : null;
  return sectionOf(visible, list === null ? null : updatedAt, () => build(list ?? []));
}

async function skillsSection(
  db: DbOrTx,
  accountId: number,
  state: LatestRow | undefined,
  periods: PeriodStarts,
): Promise<AccountPage['skills']> {
  const parsed = state?.skillsUpdatedAt ? parseSkills(state.skills) : null;
  if (!state || parsed === null) return { visible: true, shared: false };
  const current = new Map([[accountId, xpBySkill(parsed)]]);
  const since = async (from: Date) =>
    (await computeGains(db, from, current)).get(accountId) ?? new Map<string, number>();
  const day = await since(periods.today);
  const week = await since(periods.week);
  const month = await since(periods.month);
  const year = await since(periods.year);
  const gainsOf = (skill: string) => ({
    day: day.get(skill) ?? 0,
    week: week.get(skill) ?? 0,
    month: month.get(skill) ?? 0,
    year: year.get(skill) ?? 0,
  });
  const total = totalLevel(parsed);
  const overall = overallXp(parsed);
  const rows = sortSkillsForDisplay([OVERALL, ...Object.keys(parsed)]).map((skill): SkillRow => {
    if (skill === OVERALL) {
      return { skill, level: total, realLevel: total, xp: overall, gains: gainsOf(skill) };
    }
    const { xp, level } = parsed[skill] as { xp: number; level: number };
    return { skill, level, realLevel: realLevel(level), xp, gains: gainsOf(skill) };
  });
  return sectionOf(true, state.skillsUpdatedAt, () => ({
    totalLevel: total,
    overallXp: overall,
    rows,
  }));
}

async function eventsSection(
  db: DbOrTx,
  entry: AccountWithAccess,
): Promise<AccountPage['recentEvents']> {
  const rows = (await loadRecentEventRows(db, [entry.account.id], PAGE_EVENTS)).get(
    entry.account.id,
  );
  const newest = rows?.[0];
  return sectionOf(true, newest?.receivedAt, () => toFeedEvents(rows ?? [], entry));
}
