/**
 * The Metrics tab of one account (D-106): totals for a range, the session model with effective time
 * (D-107), the charts' data, per-skill rates, the bosses and the goals, for one viewer.
 *
 * Every panel needs the sharing category of its data and is null (the page shows "Not shared")
 * without it; a panel that mixes two needs both:
 *
 * | Panel | Needs |
 * |---|---|
 * | XP totals, skills, comparison of XP | `stats` |
 * | Loot totals, comparison of loot | `events` |
 * | Kill totals, bosses, comparison of kills | `hiscores` |
 * | Wealth change | `inventory` |
 * | Sessions, effective time, heatmap, scatter, rate through a session, where the time goes, a
 *   session's timeline | `activity` and `stats` (loot only counts towards them with `events`, kills
 *   only with `hiscores`) |
 *
 * Without `activity` the comparison steps by whole days at least, so it can't tell when someone
 * played (D-50).
 */
import {
  DAY_MS,
  OVERALL,
  activityKind,
  buildSessions,
  filterSessions,
  hasSessionFilter,
  heatmap,
  isSameBoss,
  levelProgress,
  periodComparison,
  rateThroughSession,
  sessionRecords,
  sortSkillsForDisplay,
  summarizeSessions,
  timeByActivity,
  type Category,
  type HeatCell,
  type MeasureSelection,
  type MetricsQuery,
  type PeriodComparison,
  type Principal,
  type RateStep,
  type SessionMetrics,
  type SessionRecords,
  type SessionsSummary,
  type TimeByActivity,
  type ValuePoint,
} from '@hub/core';
import type { DbOrTx } from '@hub/db';
import { readSessions, type PlaySession } from '../accounts/history';
import { loadVisibleAccount, type AccountWithAccess } from '../accounts/load';
import { getGains, loadCurrentSkills, seriesResolution } from '../accounts/xp';
import { loadHiscoresViews, type HiscoresView } from '../hiscores/read';
import { readGoals, toGoalViews, type GoalView } from './goals';
import { resolveMetricsRange } from './range';
import { getSession } from './session';
import {
  readDrops,
  readKillGains,
  readMarkers,
  readWealthChange,
  readXpGains,
  type AccountKillGain,
  type TimelineMarker,
} from './read';

export interface MetricsAccess {
  stats: boolean;
  events: boolean;
  hiscores: boolean;
  inventory: boolean;
  activity: boolean;
  /** Sessions and effective time: `activity` and `stats`. */
  sessions: boolean;
}

export interface MetricsTotals {
  /** XP gained in the range (all of it, hiscores fills included); null without `stats`. */
  xp: number | null;
  /** Loot value and number of drops; null without `events`. */
  gp: number | null;
  drops: number | null;
  /** Boss kills read in the range; null without `hiscores`. */
  kills: number | null;
  /** Carried wealth at the end minus the start; null without `inventory` or without data. */
  wealthChange: number | null;
  /** The sessions of the range (unfiltered); null without `sessions`. */
  sessions: SessionsSummary | null;
  /** Plugin XP and loot inside those sessions: what the rates are over. */
  sessionXp: number | null;
  sessionGp: number | null;
}

/** A session as the recap cards and the scatter show it. */
export interface SessionCard {
  id: string;
  start: string;
  end: string;
  /** Still going. */
  open: boolean;
  onlineMs: number;
  activeMs: number;
  xp: number;
  /** The skills with XP, most first. */
  xpBySkill: { skill: string; xp: number }[];
  gp: number;
  drops: number;
  kills: { activity: string; kills: number }[];
  killsShared: boolean;
  main: SessionMetrics['main'];
  /** The measure of the view in this session (active ms for `active`). */
  value: number;
}

/** One 5-minute bucket of a session timeline. */
export interface TimelineBucket {
  at: string;
  onlineMs: number;
  active: boolean;
  xp: Record<string, number>;
  gp: number;
}

export interface SessionTimeline {
  session: SessionCard;
  buckets: TimelineBucket[];
  /** Drops, level-ups, deaths and collection log entries; empty without `events`. */
  markers: TimelineMarker[];
}

export interface SkillMetrics {
  skill: string;
  xp: number;
  level: number;
  /** XP of the next level (or 200M); null at 200M. */
  nextLevelXp: number | null;
  progress: number;
  /** XP gained in the range. */
  gained: number;
  /** Plugin XP per hour over the active buckets this skill gained XP in; null without sessions. */
  xpPerHour: number | null;
  /** Time training it to the next level at that rate. */
  etaMs: number | null;
}

export interface BossMetrics {
  activity: string;
  score: number;
  rank: number | null;
  modeRank: number | null;
  /** Kills read in the range. */
  gained: number;
  /** Loot from it in the range; null without `events`. */
  gp: number | null;
}

export interface AccountMetrics {
  account: {
    publicId: string;
    name: string;
    accountType: number | null;
    relation: AccountWithAccess['access']['relation'];
    firstSeen: string;
  };
  access: MetricsAccess;
  /** Whether the viewer may set goals (the owner). */
  canSetGoals: boolean;
  range: { from: string; to: string; preset: MetricsQuery['range'] };
  totals: MetricsTotals;
  /** Sessions passing the filters, newest first; null without `sessions`. */
  sessions: SessionCard[] | null;
  /** Their summary when a session filter is set. */
  matching: SessionsSummary | null;
  records: SessionRecords | null;
  heatmap: HeatCell[] | null;
  rateThrough: RateStep[] | null;
  timeByActivity: TimeByActivity | null;
  comparison: PeriodComparison | null;
  timeline: SessionTimeline | null;
  skills: SkillMetrics[] | null;
  bosses: BossMetrics[] | null;
  hiscores: Pick<HiscoresView, 'status' | 'fetchedAt' | 'mode'> | null;
  goals: GoalView[];
  /**
   * What the filters offer: the account's skills, its bosses on the hiscores, and the sessions' main
   * activities in the range (most sessions first).
   */
  options: { skills: string[]; bosses: string[]; activities: string[] };
}

/** Sessions one view reads at most (readSessions' cap). */
export { MAX_SESSIONS } from '../accounts/history';

/**
 * The Metrics view of an account for `viewer`, or null when the account isn't visible (the page
 * answers 404). `now` is the render time, `timezone` the viewer's (Settings).
 */
export async function getAccountMetrics(
  db: DbOrTx,
  viewer: Principal,
  publicId: string,
  query: MetricsQuery,
  opts: { now: Date; timezone: string },
): Promise<AccountMetrics | null> {
  const entry = await loadVisibleAccount(db, viewer, publicId);
  if (!entry) return null;
  const has = (c: Category) => entry.access.categories.has(c);
  const access: MetricsAccess = {
    stats: has('stats'),
    events: has('events'),
    hiscores: has('hiscores'),
    inventory: has('inventory'),
    activity: has('activity'),
    sessions: has('activity') && has('stats'),
  };
  const { account } = entry;
  const window = resolveMetricsRange(query, opts.now, opts.timezone);
  const range = { from: window.from, to: window.to };
  const spanMs = range.to.getTime() - range.from.getTime();
  const endsNow = opts.now.getTime() - range.to.getTime() < 60_000;
  const sel: MeasureSelection = {
    measure: query.measure,
    skills: query.skills.length > 0 ? new Set(query.skills) : null,
    bosses: query.bosses.length > 0 ? new Set(query.bosses) : null,
  };

  // --- Hiscores and kills
  const hiscores = access.hiscores
    ? ((await loadHiscoresViews(db, [account])).get(account.id) ?? null)
    : null;
  const killRange = {
    from: new Date(range.from.getTime() - (query.compare ? spanMs : 0)),
    to: range.to,
  };
  const allKills = access.hiscores ? await readKillGains(db, [account.id], killRange) : [];
  const bossKills = allKills.filter((k) => activityKind(k.activity) === 'boss');
  const inRange = (at: number) => at > range.from.getTime() && at <= range.to.getTime();
  const killsGained = sumBy(
    bossKills.filter((k) => inRange(k.at)),
    (k) => k.activity,
    (k) => k.kills,
  );

  // --- Sessions (activity + stats)
  let playSessions: PlaySession[] = [];
  if (access.sessions) playSessions = await readSessions(db, account.id, range);
  const sessionStart = Math.min(
    range.from.getTime(),
    ...playSessions.map((s) => Date.parse(s.startedAt)),
  );
  const readRange = { from: new Date(sessionStart), to: range.to };

  const gains = access.stats ? await readXpGains(db, account.id, readRange) : [];
  const drops = access.events
    ? await readDrops(db, account.id, {
        from: new Date(Math.min(sessionStart, range.from.getTime() - (query.compare ? spanMs : 0))),
        to: range.to,
      })
    : [];

  const built = access.sessions
    ? buildSessions({
        spans: playSessions.map((s) => ({
          id: s.id,
          start: Date.parse(s.startedAt),
          end: Date.parse(s.endedAt ?? s.lastSeenAt),
        })),
        gains,
        drops: drops.filter((d) => d.at >= sessionStart),
        kills: bossKills,
        lootActive: access.events,
      })
    : [];
  const openIds = new Set(playSessions.filter((s) => s.endedAt === null).map((s) => s.id));
  const filtered = filterSessions(
    built,
    {
      minMs: query.minMinutes === null ? null : query.minMinutes * 60_000,
      weekdays: query.weekdays.length > 0 ? new Set(query.weekdays) : null,
      hours: query.hours,
      activity: query.activity,
    },
    opts.timezone,
  );
  const card = (s: SessionMetrics) => toCard(s, sel, openIds.has(s.id));

  // --- Totals
  const xpGains = access.stats
    ? await getGains(db, account.id, endsNow ? { from: range.from } : range)
    : null;
  const rangeDrops = drops.filter(
    (d) => d.at >= range.from.getTime() && d.at <= range.to.getTime(),
  );
  const totals: MetricsTotals = {
    xp: xpGains ? (xpGains.get(OVERALL) ?? 0) : null,
    gp: access.events ? sum(rangeDrops.map((d) => d.value)) : null,
    drops: access.events ? rangeDrops.length : null,
    kills: access.hiscores ? sum([...killsGained.values()]) : null,
    wealthChange: access.inventory ? await readWealthChange(db, account.id, range) : null,
    sessions: access.sessions ? summarizeSessions(built, sel) : null,
    sessionXp: access.sessions ? sum(built.map((s) => s.xp)) : null,
    sessionGp: access.sessions && access.events ? sum(built.map((s) => s.gp)) : null,
  };

  // --- Comparison
  const comparison = await loadComparison(db, account.id, {
    query,
    sel,
    access,
    range,
    spanMs,
    now: opts.now,
    drops,
    kills: bossKills,
    sessions: built,
  });

  // --- Selected session
  const timeline =
    access.sessions && query.session
      ? await loadTimeline(db, entry, query.session, sel, access)
      : null;

  // --- Skills
  let skills: SkillMetrics[] | null = null;
  const current = access.stats
    ? ((await loadCurrentSkills(db, [account.id])).get(account.id) ?? {})
    : {};
  if (access.stats) {
    const trained = skillRates(built);
    skills = sortSkillsForDisplay(Object.keys(current)).map((skill) => {
      const xp = current[skill]!.xp;
      const p = levelProgress(xp);
      const rate = trained.get(skill);
      const xpPerHour = rate && rate.activeMs > 0 ? (rate.xp / rate.activeMs) * 3_600_000 : null;
      return {
        skill,
        xp,
        level: p.level,
        nextLevelXp: p.to,
        progress: p.share,
        gained: xpGains?.get(skill) ?? 0,
        xpPerHour: access.sessions ? xpPerHour : null,
        etaMs:
          p.to !== null && xpPerHour !== null && xpPerHour > 0
            ? ((p.to - xp) / xpPerHour) * 3_600_000
            : null,
      };
    });
  }

  // --- Bosses
  let bosses: BossMetrics[] | null = null;
  if (hiscores) {
    bosses = hiscores.activities
      .filter((a) => a.kind === 'boss')
      .map((a) => ({
        activity: a.activity,
        score: a.score,
        rank: a.rank,
        modeRank: a.modeRank,
        gained: killsGained.get(a.activity) ?? 0,
        gp: access.events
          ? sum(rangeDrops.filter((d) => isSameBoss(a.activity, d.source)).map((d) => d.value))
          : null,
      }))
      .sort((a, b) => b.gained - a.gained || b.score - a.score);
  }

  // --- Goals
  const goals = toGoalViews(await readGoals(db, entry), {
    xp: new Map(Object.entries(current).map(([skill, v]) => [skill, v.xp])),
    kc: new Map(hiscores?.activities.map((a) => [a.activity, a.score]) ?? []),
    xpGained: xpGains ?? new Map(),
    killsGained: sumBy(
      allKills.filter((k) => inRange(k.at)),
      (k) => k.activity,
      (k) => k.kills,
    ),
    days: spanMs / DAY_MS,
  });

  // Most sessions first: the order the charts give the categorical colours in, so a filter never
  // repaints an activity.
  const mains = sumBy(
    built.filter((s) => s.main !== null),
    (s) => s.main!.name,
    () => 1,
  );
  const activities = [...mains.entries()]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
    .map(([name]) => name);
  return {
    account: {
      publicId: account.publicId,
      name: account.name,
      accountType: account.accountType,
      relation: entry.access.relation,
      firstSeen: account.firstSeen.toISOString(),
    },
    access,
    canSetGoals: entry.access.relation === 'owner',
    range: { from: range.from.toISOString(), to: range.to.toISOString(), preset: window.preset },
    totals,
    sessions: access.sessions ? filtered.map(card).reverse() : null,
    matching: access.sessions && hasSessionFilter(query) ? summarizeSessions(filtered, sel) : null,
    records: access.sessions ? sessionRecords(filtered) : null,
    heatmap: access.sessions ? heatmap(filtered, sel, opts.timezone) : null,
    rateThrough: access.sessions ? rateThroughSession(filtered, sel) : null,
    // The page folds these into its three coloured activities and Other.
    timeByActivity: access.sessions ? timeByActivity(filtered, opts.timezone, 20) : null,
    comparison,
    timeline,
    skills,
    bosses,
    hiscores: hiscores
      ? { status: hiscores.status, fetchedAt: hiscores.fetchedAt, mode: hiscores.mode }
      : null,
    goals,
    options: {
      skills: sortSkillsForDisplay(Object.keys(current)),
      bosses: (hiscores?.activities ?? []).filter((a) => a.kind === 'boss').map((a) => a.activity),
      activities,
    },
  };
}

function toCard(s: SessionMetrics, sel: MeasureSelection, open: boolean): SessionCard {
  return {
    id: s.id,
    start: new Date(s.start).toISOString(),
    end: new Date(s.end).toISOString(),
    open,
    onlineMs: s.onlineMs,
    activeMs: s.activeMs,
    xp: s.xp,
    xpBySkill: Object.entries(s.xpBySkill)
      .map(([skill, xp]) => ({ skill, xp }))
      .sort((a, b) => b.xp - a.xp),
    gp: s.gp,
    drops: s.drops,
    kills: Object.entries(s.kills)
      .map(([activity, kills]) => ({ activity, kills }))
      .sort((a, b) => b.kills - a.kills),
    killsShared: s.killsShared,
    main: s.main,
    value: sessionValueOf(s, sel),
  };
}

function sessionValueOf(s: SessionMetrics, sel: MeasureSelection): number {
  return summarizeSessions([s], sel).value;
}

/** Per skill: plugin XP and active time of the buckets it gained XP in. */
function skillRates(
  sessions: readonly SessionMetrics[],
): Map<string, { xp: number; activeMs: number }> {
  const out = new Map<string, { xp: number; activeMs: number }>();
  for (const s of sessions) {
    for (const b of s.buckets) {
      for (const [skill, xp] of Object.entries(b.xp)) {
        const row = out.get(skill) ?? { xp: 0, activeMs: 0 };
        row.xp += xp;
        row.activeMs += b.onlineMs;
        out.set(skill, row);
      }
    }
  }
  return out;
}

interface ComparisonInput {
  query: MetricsQuery;
  sel: MeasureSelection;
  access: MetricsAccess;
  range: { from: Date; to: Date };
  spanMs: number;
  now: Date;
  drops: readonly { at: number; value: number }[];
  kills: readonly AccountKillGain[];
  sessions: readonly SessionMetrics[];
}

/**
 * The period comparison of the view's measure, or null when the viewer can't read it. XP comes from
 * the tier that fits the span (5 minutes up to 7 days, hourly up to 90, daily beyond; the hiscores'
 * fills included: mobile play counts here). Active time needs sessions, which reach no further back
 * than the range, so it is never compared with the period before.
 */
async function loadComparison(
  db: DbOrTx,
  accountId: number,
  input: ComparisonInput,
): Promise<PeriodComparison | null> {
  const { query, sel, access, range, spanMs } = input;
  const from = new Date(range.from.getTime() - (query.compare ? spanMs : 0));
  let points: ValuePoint[];
  switch (sel.measure) {
    case 'xp': {
      if (!access.stats) return null;
      const resolution = await seriesResolution(db, from, range.to, 'auto');
      const gains = await readXpGains(db, accountId, { from, to: range.to }, resolution);
      points = gains
        .filter((g) => !sel.skills || sel.skills.has(g.skill))
        .map((g) => ({ at: g.at, value: g.xp }));
      break;
    }
    case 'gp':
      if (!access.events) return null;
      points = input.drops.map((d) => ({ at: d.at, value: d.value }));
      break;
    case 'kills':
      if (!access.hiscores) return null;
      points = input.kills
        .filter((k) => !sel.bosses || sel.bosses.has(k.activity))
        .map((k) => ({ at: k.at, value: k.kills }));
      break;
    case 'active':
      if (!access.sessions) return null;
      points = input.sessions.flatMap((s) =>
        s.buckets.filter((b) => b.active).map((b) => ({ at: b.at, value: b.onlineMs })),
      );
      break;
  }
  return periodComparison(
    points,
    { from: range.from.getTime(), to: range.to.getTime(), now: input.now.getTime() },
    {
      compare: query.compare && sel.measure !== 'active',
      // Without `activity`, nothing finer than a day (D-50).
      minStepMs: access.activity ? 0 : DAY_MS,
    },
  );
}

/**
 * The timeline of one session of the account, wherever it lies; null when there is no such session.
 * Its kills are attributed with the sessions of the two days after it in view, as in the range.
 */
async function loadTimeline(
  db: DbOrTx,
  entry: AccountWithAccess,
  sessionId: string,
  sel: MeasureSelection,
  access: MetricsAccess,
): Promise<SessionTimeline | null> {
  const accountId = entry.account.id;
  const session = await getSession(db, accountId, sessionId);
  if (!session) return null;
  const range = { from: new Date(session.start), to: new Date(session.end) };
  const after = { from: range.from, to: new Date(session.end + 2 * DAY_MS) };
  const neighbours = (await readSessions(db, accountId, after)).filter(
    (s) => s.id !== session.id && Date.parse(s.startedAt) >= session.start,
  );
  const [built] = buildSessions({
    spans: [
      { id: session.id, start: session.start, end: session.end },
      ...neighbours.map((s) => ({
        id: s.id,
        start: Date.parse(s.startedAt),
        end: Date.parse(s.endedAt ?? s.lastSeenAt),
      })),
    ],
    gains: await readXpGains(db, accountId, range),
    drops: access.events ? await readDrops(db, accountId, range) : [],
    kills: access.hiscores
      ? (await readKillGains(db, [accountId], after)).filter(
          (k) => activityKind(k.activity) === 'boss',
        )
      : [],
    lootActive: access.events,
  });
  if (!built || built.id !== session.id) return null;
  return {
    session: toCard(built, sel, session.open),
    buckets: built.buckets.map((b) => ({
      at: new Date(b.at).toISOString(),
      onlineMs: b.onlineMs,
      active: b.active,
      xp: b.xp,
      gp: b.gp,
    })),
    markers: access.events
      ? await readMarkers(db, { id: accountId, name: entry.account.name }, range)
      : [],
  };
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

function sumBy<T>(
  items: readonly T[],
  key: (item: T) => string,
  value: (item: T) => number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) out.set(key(item), (out.get(key(item)) ?? 0) + value(item));
  return out;
}
