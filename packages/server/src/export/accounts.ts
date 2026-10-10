/**
 * One account in the data export (D-79): who plays it (the names the UI shows the user, D-68), its
 * current state section by section, and its full histories, each only for a category the user can see
 * today (resolveAccess). The histories are streamed in keyset-paginated batches, never loaded whole.
 */
import { CATEGORIES, DAY_MS, accountTypeLabel, floorTo, type Category } from '@hub/core';
import {
  accountLinks,
  accountNames,
  activityScores,
  equipmentChanges,
  events,
  locationSamples,
  playSessions,
  users,
  wealthDaily,
  xpDaily,
  xpSamples,
  type Db,
} from '@hub/db';
import { and, asc, desc, eq, gt, min, ne, sql, type SQL } from 'drizzle-orm';
import type { AccountWithAccess } from '../accounts/load';
import { loadAccountSections } from '../api/state';
import { readGoals } from '../account-metrics/goals';
import { loadHiscoresViews } from '../hiscores/read';
import { toApiItems } from '../api/types';
import { EVENT_ROW_COLUMNS, toFeedEvent } from '../feed';
import { jsonArray, jsonObject, keysetPages, streamed, type Field } from './json';
import {
  wireEvent,
  wireItem,
  wireItems,
  wireLocation,
  wirePresence,
  wireSection,
  wireSkills,
  wireVitals,
  wireWealthDay,
} from './wire';

export interface AccountExportContext {
  db: Db;
  userId: string;
  now: Date;
  /** Rows per query of a history (≈5,000; tests use a few). */
  batchSize: number;
  /** skills.id → name, for the XP histories. */
  skillNames: ReadonlyMap<number, string>;
}

/**
 * The account as a JSON object, in pieces. What `entry.access.categories` doesn't hold is left out
 * entirely: no section, no history, and events redacted as the feed redacts them for this user.
 */
export function accountDocument(
  ctx: AccountExportContext,
  entry: AccountWithAccess,
): AsyncGenerator<string> {
  return jsonObject(accountFields(ctx, entry));
}

async function* accountFields(
  ctx: AccountExportContext,
  entry: AccountWithAccess,
): AsyncGenerator<Field> {
  const { db, now } = ctx;
  const { account, access } = entry;
  const can = (c: Category) => access.categories.has(c);
  yield ['id', account.publicId];
  yield ['name', account.name];
  yield ['type', account.accountType];
  yield ['type_label', accountTypeLabel(account.accountType)];
  yield ['relation', access.relation];
  // Only an admin can see a hidden account (its owner is in grace).
  yield ['hidden', account.status === 'hidden'];
  yield ['first_seen', account.firstSeen.toISOString()];
  // A last-seen time is presence (D-50).
  yield ['last_seen', can('activity') ? account.lastSeen.toISOString() : null];
  yield* peopleFields(db, ctx.userId, entry);
  yield ['previous_names', await previousNames(db, entry)];
  yield ['categories', CATEGORIES.filter(can)];
  yield* stateFields(db, entry, now);
  yield* historyFields(ctx, entry);
}

/**
 * `owner` and `contributors` (names only, D-68: the user is the owner or a contributor, who may read
 * the contributor list), blocked users left out; `your_link`: when the user's devices first and last
 * reported the account.
 */
async function* peopleFields(
  db: Db,
  userId: string,
  { account }: AccountWithAccess,
): AsyncGenerator<Field> {
  const links = await db
    .select({
      userId: accountLinks.userId,
      name: users.name,
      blocked: accountLinks.blocked,
      firstSeen: accountLinks.firstSeen,
      lastSeen: accountLinks.lastSeen,
    })
    .from(accountLinks)
    .innerJoin(users, eq(users.id, accountLinks.userId))
    .where(eq(accountLinks.accountId, account.id))
    .orderBy(asc(accountLinks.firstSeen), asc(accountLinks.userId));
  let ownerName = links.find((l) => l.userId === account.ownerUserId)?.name;
  if (ownerName === undefined && account.ownerUserId !== null) {
    const [owner] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, account.ownerUserId));
    ownerName = owner?.name;
  }
  yield [
    'owner',
    ownerName === undefined ? null : { name: ownerName, you: account.ownerUserId === userId },
  ];
  yield [
    'contributors',
    links
      .filter((l) => !l.blocked && l.userId !== account.ownerUserId)
      .map((l) => ({ name: l.name, you: l.userId === userId })),
  ];
  const own = links.find((l) => l.userId === userId);
  yield [
    'your_link',
    own ? { first_seen: own.firstSeen.toISOString(), last_seen: own.lastSeen.toISOString() } : null,
  ];
}

async function previousNames(db: Db, { account }: AccountWithAccess) {
  const rows = await db
    .select({
      name: accountNames.name,
      firstSeen: accountNames.firstSeen,
      lastSeen: accountNames.lastSeen,
    })
    .from(accountNames)
    .where(and(eq(accountNames.accountId, account.id), ne(accountNames.name, account.name)))
    .orderBy(desc(accountNames.lastSeen));
  return rows.map((r) => ({
    name: r.name,
    first_seen: r.firstSeen.toISOString(),
    last_seen: r.lastSeen.toISOString(),
  }));
}

/**
 * The current state, section by section exactly as GET /api/v1/accounts/{id} returns it (the same
 * accountSections, in the wire format): `{ shared: true, updated_at, … }`,
 * `{ shared: false, updated_at: null }` when the plugin never sent it, and no field at all for a
 * category the user can't see. Without `activity`, skills, equipment and inventory carry only the
 * day (D-50).
 */
async function* stateFields(db: Db, entry: AccountWithAccess, now: Date): AsyncGenerator<Field> {
  const { presence, vitals, skills, location, equipment, inventory } = await loadAccountSections(
    db,
    entry.account.id,
    entry.access.categories,
    now,
  );
  if (presence) yield ['presence', wireSection(presence, wirePresence)];
  if (vitals) yield ['vitals', wireSection(vitals, wireVitals)];
  if (skills) yield ['skills', wireSection(skills, wireSkills)];
  if (location) yield ['location', wireSection(location, wireLocation)];
  if (equipment) yield ['equipment', wireSection(equipment, wireItems)];
  if (inventory) yield ['inventory', wireSection(inventory, wireItems)];
}

/** The histories, each gated by its category (handoff §10) and streamed in batches. */
async function* historyFields(
  ctx: AccountExportContext,
  entry: AccountWithAccess,
): AsyncGenerator<Field> {
  const can = (c: Category) => entry.access.categories.has(c);
  const id = entry.account.id;
  if (can('stats')) {
    yield ['xp_samples', streamed(() => jsonArray(xpSamplePages(ctx, id), wireXp(ctx)))];
    // Read after the raw rows were written out: if retention drops a chunk meanwhile, the daily
    // rows overlap the raw ones instead of leaving a gap.
    const rawStart = await firstRawBucket(ctx.db, id);
    yield ['xp_daily', streamed(() => jsonArray(xpDailyPages(ctx, id, rawStart), wireXpDay(ctx)))];
  }
  if (can('events')) {
    const ref = { publicId: entry.account.publicId, name: entry.account.name };
    const categories = entry.access.categories;
    yield [
      'events',
      streamed(() =>
        jsonArray(eventPages(ctx, id), (row) => wireEvent(toFeedEvent(row, ref, categories))),
      ),
    ];
  }
  if (can('activity')) {
    yield ['sessions', streamed(() => jsonArray(sessionPages(ctx, id), wirePlay))];
  }
  if (can('equipment')) {
    yield ['equipment_changes', streamed(() => jsonArray(equipmentPages(ctx, id), wireChange))];
  }
  if (can('inventory')) {
    yield ['wealth_days', streamed(() => jsonArray(wealthPages(ctx, id), wireWealthDay))];
  }
  if (can('location_history')) {
    yield ['location_trail', streamed(() => jsonArray(locationPages(ctx, id), wirePoint))];
  }
  if (can('hiscores')) {
    // Lookups follow the end of a session by minutes: without `activity`, their times are day-only
    // like the API's (D-50).
    const exact = can('activity');
    yield ['hiscores', await hiscoresField(ctx.db, entry, exact)];
    yield ['activity_scores', streamed(() => jsonArray(scorePages(ctx, id), wireScore(exact)))];
  }
  // Goals go with the account (D-109), each only when its category is readable (readGoals).
  const goals = await readGoals(ctx.db, entry);
  if (goals.length > 0) {
    const exact = can('activity');
    yield [
      'goals',
      goals.map((g) => ({
        kind: g.kind,
        target: g.target,
        value: g.value,
        created_at: stamp(new Date(g.createdAt), exact),
      })),
    ];
  }
}

const stamp = (at: Date, exact: boolean) => (exact ? at : floorTo(at, DAY_MS)).toISOString();

/** `hiscores`: the latest lookup, as GET /api/v1/accounts/{id}/hiscores returns it (D-105). */
async function hiscoresField(db: Db, { account }: AccountWithAccess, exact: boolean) {
  const view = (await loadHiscoresViews(db, [account])).get(account.id)!;
  return {
    status: view.status,
    fetched_at: view.fetchedAt === null ? null : stamp(new Date(view.fetchedAt), exact),
    mode: view.mode,
    skills: view.skills.map((s) => ({
      skill: s.skill,
      level: s.level,
      xp: s.xp,
      rank: s.rank,
      mode_rank: s.modeRank,
    })),
    activities: view.activities.map((a) => ({
      activity: a.activity,
      kind: a.kind,
      score: a.score,
      rank: a.rank,
      mode_rank: a.modeRank,
    })),
  };
}

type ScoreRow = {
  activity: string;
  readAt: Date;
  score: number;
  baseline: boolean;
  cursor: string;
};

/** `activity_scores`: every change of a score the hiscores showed, by activity, then time. */
function scorePages(ctx: AccountExportContext, accountId: number) {
  return keysetPages<ScoreRow>(
    (last, limit) =>
      ctx.db
        .select({
          activity: activityScores.activity,
          readAt: activityScores.readAt,
          score: activityScores.score,
          baseline: activityScores.baseline,
          cursor: sql<string>`${activityScores.readAt}::text`,
        })
        .from(activityScores)
        .where(
          and(
            eq(activityScores.accountId, accountId),
            after(
              sql`${activityScores.activity}, ${activityScores.readAt}`,
              last && sql`${last.activity}, ${last.cursor}::timestamptz`,
            ),
          ),
        )
        .orderBy(asc(activityScores.activity), asc(activityScores.readAt))
        .limit(limit),
    ctx.batchSize,
  );
}

function wireScore(exact: boolean) {
  return (r: ScoreRow) => ({
    activity: r.activity,
    read_at: stamp(r.readAt, exact),
    score: r.score,
    baseline: r.baseline,
  });
}

/**
 * A keyset condition on (a, b) after the cursor. A timestamp's cursor is its text form, which keeps
 * the microseconds a JS Date would drop (a truncated cursor would read the row again).
 */
function after(columns: SQL, cursor: SQL | null): SQL | undefined {
  return cursor === null ? undefined : sql`(${columns}) > (${cursor})`;
}

const xpSampleColumns = {
  skillId: xpSamples.skillId,
  bucket: xpSamples.bucket,
  xp: xpSamples.xp,
  level: xpSamples.level,
  cursor: sql<string>`${xpSamples.bucket}::text`,
};

type XpRow = { skillId: number; bucket: Date; xp: number; level: number; cursor: string };

/** `xp_samples`: every raw row still kept (XP_RAW_RETENTION_DAYS), by skill, then time. */
function xpSamplePages(ctx: AccountExportContext, accountId: number) {
  return keysetPages<XpRow>(
    (last, limit) =>
      ctx.db
        .select(xpSampleColumns)
        .from(xpSamples)
        .where(
          and(
            eq(xpSamples.accountId, accountId),
            after(
              sql`${xpSamples.skillId}, ${xpSamples.bucket}`,
              last && sql`${last.skillId}::smallint, ${last.cursor}::timestamptz`,
            ),
          ),
        )
        .orderBy(asc(xpSamples.skillId), asc(xpSamples.bucket))
        .limit(limit),
    ctx.batchSize,
  );
}

/** The first raw XP bucket still kept for the account; null when there is none. */
async function firstRawBucket(db: Db, accountId: number): Promise<Date | null> {
  const [row] = await db
    .select({ first: min(xpSamples.bucket) })
    .from(xpSamples)
    .where(eq(xpSamples.accountId, accountId));
  return row?.first ?? null;
}

/**
 * `xp_daily`: the last XP of each UTC day (the continuous aggregate, kept forever) for the days
 * before the first raw sample's day, which the raw rows cover. Retention drops raw rows by time for
 * every skill alike, so one cut per account is exact; with no raw rows at all, every day is here.
 */
function xpDailyPages(ctx: AccountExportContext, accountId: number, rawStart: Date | null) {
  const before =
    rawStart === null
      ? undefined
      : sql`${xpDaily.bucket} < ${floorTo(rawStart, DAY_MS).toISOString()}::timestamptz`;
  return keysetPages<XpRow>(
    (last, limit) =>
      ctx.db
        .select({
          skillId: xpDaily.skillId,
          bucket: xpDaily.bucket,
          xp: xpDaily.xp,
          level: xpDaily.level,
          cursor: sql<string>`${xpDaily.bucket}::text`,
        })
        .from(xpDaily)
        .where(
          and(
            eq(xpDaily.accountId, accountId),
            before,
            after(
              sql`${xpDaily.skillId}, ${xpDaily.bucket}`,
              last && sql`${last.skillId}::smallint, ${last.cursor}::timestamptz`,
            ),
          ),
        )
        .orderBy(asc(xpDaily.skillId), asc(xpDaily.bucket))
        .limit(limit),
    ctx.batchSize,
  );
}

function wireXp(ctx: AccountExportContext) {
  return (r: XpRow) => ({
    skill: ctx.skillNames.get(r.skillId) ?? null,
    bucket: new Date(r.bucket).toISOString(),
    xp: Number(r.xp),
    level: r.level,
  });
}

function wireXpDay(ctx: AccountExportContext) {
  return (r: XpRow) => ({
    skill: ctx.skillNames.get(r.skillId) ?? null,
    day: new Date(r.bucket).toISOString().slice(0, 10),
    xp: Number(r.xp),
    level: r.level,
  });
}

type EventRow = Awaited<ReturnType<typeof readEvents>>[number];

function readEvents(
  ctx: AccountExportContext,
  accountId: number,
  afterSeq: number | null,
  limit: number,
) {
  // See DB-15, mirrored: events_account_seq_idx (seq DESC NULLS LAST) read backward is ASC NULLS
  // FIRST, and a plain ASC (NULLS LAST) isn't read off it: it walks events_seq_uidx past every other
  // account's rows instead.
  return ctx.db
    .select(EVENT_ROW_COLUMNS)
    .from(events)
    .where(
      and(
        eq(events.accountId, accountId),
        afterSeq === null ? undefined : gt(events.seq, afterSeq),
      ),
    )
    .orderBy(sql`${events.seq} ASC NULLS FIRST`)
    .limit(limit);
}

/** `events`: every event, oldest first (by seq, the feed's order). */
function eventPages(ctx: AccountExportContext, accountId: number) {
  return keysetPages<EventRow>(
    (last, limit) => readEvents(ctx, accountId, last?.seq ?? null, limit),
    ctx.batchSize,
  );
}

const sessionColumns = {
  id: playSessions.id,
  startedAt: playSessions.startedAt,
  endedAt: playSessions.endedAt,
  lastSeenAt: playSessions.lastSeenAt,
  worlds: playSessions.worlds,
  endReason: playSessions.endReason,
  cursor: sql<string>`${playSessions.startedAt}::text`,
};

type SessionRow = {
  id: string;
  startedAt: Date;
  endedAt: Date | null;
  lastSeenAt: Date;
  worlds: number[];
  endReason: string | null;
  cursor: string;
};

/** `sessions`: every play session, oldest first. */
function sessionPages(ctx: AccountExportContext, accountId: number) {
  return keysetPages<SessionRow>(
    (last, limit) =>
      ctx.db
        .select(sessionColumns)
        .from(playSessions)
        .where(
          and(
            eq(playSessions.accountId, accountId),
            after(
              sql`${playSessions.startedAt}, ${playSessions.id}`,
              last && sql`${last.cursor}::timestamptz, ${last.id}::uuid`,
            ),
          ),
        )
        // See DB-15, mirrored: play_sessions_account_started_idx read backward is ASC NULLS FIRST.
        .orderBy(sql`${playSessions.startedAt} ASC NULLS FIRST`, asc(playSessions.id))
        .limit(limit),
    ctx.batchSize,
  );
}

function wirePlay(r: SessionRow) {
  const end = r.endedAt ?? r.lastSeenAt;
  return {
    id: r.id,
    started_at: r.startedAt.toISOString(),
    ended_at: r.endedAt?.toISOString() ?? null,
    last_seen_at: r.lastSeenAt.toISOString(),
    duration_ms: Math.max(0, end.getTime() - r.startedAt.getTime()),
    worlds: r.worlds,
    end_reason: r.endReason,
  };
}

type ChangeRow = { id: number; changedAt: Date; equipment: unknown; cursor: string };

/**
 * `equipment_changes`: the whole worn set after each change, oldest first (changes of one instant
 * by id). Paged on (changed_at, id), which equipment_changes_account_idx serves; by id alone no
 * index has an account's rows in order, and every page sorted all that were left.
 */
function equipmentPages(ctx: AccountExportContext, accountId: number) {
  return keysetPages<ChangeRow>(
    (last, limit) =>
      ctx.db
        .select({
          id: equipmentChanges.id,
          changedAt: equipmentChanges.changedAt,
          equipment: equipmentChanges.equipment,
          cursor: sql<string>`${equipmentChanges.changedAt}::text`,
        })
        .from(equipmentChanges)
        .where(
          and(
            eq(equipmentChanges.accountId, accountId),
            after(
              sql`${equipmentChanges.changedAt}, ${equipmentChanges.id}`,
              last && sql`${last.cursor}::timestamptz, ${last.id}::bigint`,
            ),
          ),
        )
        // See DB-15, mirrored: equipment_changes_account_idx read backward is ASC NULLS FIRST.
        .orderBy(sql`${equipmentChanges.changedAt} ASC NULLS FIRST`, asc(equipmentChanges.id))
        .limit(limit),
    ctx.batchSize,
  );
}

function wireChange(r: ChangeRow) {
  return { changed_at: r.changedAt.toISOString(), items: toApiItems(r.equipment).map(wireItem) };
}

type WealthRow = { day: string; lastValue: number; maxValue: number };

/** `wealth_days`: carried wealth per UTC day, oldest first. */
function wealthPages(ctx: AccountExportContext, accountId: number) {
  return keysetPages<WealthRow>(
    (last, limit) =>
      ctx.db
        .select({
          day: wealthDaily.day,
          lastValue: wealthDaily.lastValue,
          maxValue: wealthDaily.maxValue,
        })
        .from(wealthDaily)
        .where(
          and(
            eq(wealthDaily.accountId, accountId),
            last === null ? undefined : gt(wealthDaily.day, last.day),
          ),
        )
        .orderBy(asc(wealthDaily.day))
        .limit(limit),
    ctx.batchSize,
  );
}

type PointRow = {
  ts: Date;
  x: number;
  y: number;
  plane: number;
  world: number | null;
  onBoat: boolean;
  cursor: string;
};

/**
 * `location_trail`: every point still kept (LOCATION_RETENTION_DAYS), oldest first. Not capped like
 * the API: the export streams it in pages.
 */
function locationPages(ctx: AccountExportContext, accountId: number) {
  return keysetPages<PointRow>(
    (last, limit) =>
      ctx.db
        .select({
          ts: locationSamples.ts,
          x: locationSamples.x,
          y: locationSamples.y,
          plane: locationSamples.plane,
          world: locationSamples.world,
          onBoat: locationSamples.onBoat,
          cursor: sql<string>`${locationSamples.ts}::text`,
        })
        .from(locationSamples)
        .where(
          and(
            eq(locationSamples.accountId, accountId),
            after(sql`${locationSamples.ts}`, last && sql`${last.cursor}::timestamptz`),
          ),
        )
        .orderBy(asc(locationSamples.ts))
        .limit(limit),
    ctx.batchSize,
  );
}

function wirePoint(r: PointRow) {
  return {
    at: r.ts.toISOString(),
    x: r.x,
    y: r.y,
    plane: r.plane,
    world: r.world,
    is_on_boat: r.onBoat,
  };
}
