/**
 * Metrics' session model (D-106, D-107): what happened in each play session, cut into the 5-minute
 * buckets XP is stored in, and the summaries every Metrics chart is drawn from. Pure: the server reads
 * the rows (packages/server/src/metrics) and hands them in as plain numbers.
 *
 * Effective time (D-107). A 5-minute bucket of a session is **active** when the account gained XP in
 * it (from the plugin; XP the hiscores filled in was made outside any session, D-105) or, when the
 * viewer may read the account's events, had a loot drop in it; otherwise it is **idle** (banking,
 * walking, AFK). Active time is the online time of the active buckets; effective share = active ÷
 * online. 5 minutes is the resolution of xp_samples, so a short bank trip inside a busy bucket counts
 * as active.
 *
 * Kill counts come from the hiscores, read about 10 minutes after a session ends (D-105), so they are
 * per session, never per bucket: a reading's gain goes to the session that ended shortly before it
 * (attributeKills).
 */
import { MINUTE_MS } from '../time';
import { LocalClockCache } from './clock';

/** The bucket size of effective time: the resolution of xp_samples. */
export const METRICS_BUCKET_MS = 5 * MINUTE_MS;

export const METRICS_MEASURES = ['xp', 'gp', 'kills', 'active'] as const;
/** What a Metrics chart counts: XP, loot value, kills, or active time. */
export type MetricsMeasure = (typeof METRICS_MEASURES)[number];

export function isMetricsMeasure(value: unknown): value is MetricsMeasure {
  return typeof value === 'string' && (METRICS_MEASURES as readonly string[]).includes(value);
}

/** XP gained in one 5-minute bucket of one skill (`at` = the bucket's start). */
export interface XpGain {
  at: number;
  skill: string;
  xp: number;
  /** Written by the hiscores (XP made outside RuneLite, D-105): never makes a bucket active. */
  fromHiscores: boolean;
}

/** One loot drop. */
export interface Drop {
  at: number;
  value: number;
  /** Who or what dropped it ("Zulrah"), as the plugin names it; null when not sent. */
  source: string | null;
}

/** One play session: [start, end]; an open session ends at its last payload. */
export interface SessionSpan {
  id: string;
  start: number;
  end: number;
}

/**
 * A rise of one hiscore score between two readings of the same series (activity_scores, never across
 * a baseline row): `kills` were made between `prevAt` and `at`.
 */
export interface KillGain {
  at: number;
  prevAt: number;
  activity: string;
  kills: number;
}

export interface MetricsBucket {
  /** The bucket's start (ms). */
  at: number;
  /** How much of the bucket the session covers. */
  onlineMs: number;
  active: boolean;
  /** Plugin XP gained per skill. */
  xp: Record<string, number>;
  /** Loot value (0 without drops, or when the viewer can't read events). */
  gp: number;
  drops: number;
  /**
   * What the bucket was spent on: the source of its most valuable drop, else the skill with the most
   * XP; null for an idle bucket.
   */
  activity: string | null;
}

export interface MainActivity {
  kind: 'boss' | 'skill';
  name: string;
}

export interface SessionMetrics {
  id: string;
  start: number;
  end: number;
  onlineMs: number;
  activeMs: number;
  /** Plugin XP gained in the session, all skills. */
  xp: number;
  xpBySkill: Record<string, number>;
  gp: number;
  drops: number;
  /** Kills per hiscores activity read after this session (see attributeKills). */
  kills: Record<string, number>;
  /** The kills came from one reading that covered this and earlier sessions together. */
  killsShared: boolean;
  /** The boss with the most kills, else the skill with the most XP; null when neither. */
  main: MainActivity | null;
  buckets: MetricsBucket[];
}

export interface BuildSessionsInput {
  spans: readonly SessionSpan[];
  gains: readonly XpGain[];
  drops: readonly Drop[];
  kills: readonly KillGain[];
  /** Drops make a bucket active (the viewer may read events). */
  lootActive: boolean;
}

/** The sessions of a range with their buckets, oldest first. */
export function buildSessions(input: BuildSessionsInput): SessionMetrics[] {
  const xpByBucket = new Map<number, Record<string, number>>();
  for (const g of input.gains) {
    if (g.fromHiscores || !(g.xp > 0)) continue;
    const at = floorBucket(g.at);
    const row = xpByBucket.get(at) ?? {};
    row[g.skill] = (row[g.skill] ?? 0) + g.xp;
    xpByBucket.set(at, row);
  }
  const dropsByBucket = new Map<number, Drop[]>();
  for (const d of input.drops) {
    const at = floorBucket(d.at);
    const list = dropsByBucket.get(at) ?? [];
    list.push(d);
    dropsByBucket.set(at, list);
  }

  const spans = [...input.spans].sort((a, b) => a.start - b.start);
  /** A bucket two touching sessions share is counted once, by the first. */
  const used = new Set<number>();
  const sessions = spans.map((span) => {
    const buckets: MetricsBucket[] = [];
    if (span.end >= span.start) {
      for (let at = floorBucket(span.start); at <= span.end; at += METRICS_BUCKET_MS) {
        const onlineMs = Math.min(span.end, at + METRICS_BUCKET_MS) - Math.max(span.start, at);
        const shared = used.has(at);
        used.add(at);
        const xp = shared ? {} : (xpByBucket.get(at) ?? {});
        const drops = shared ? [] : (dropsByBucket.get(at) ?? []);
        const xpTotal = sum(Object.values(xp));
        const gp = sum(drops.map((d) => d.value));
        const active = xpTotal > 0 || (input.lootActive && drops.length > 0);
        buckets.push({
          at,
          onlineMs: Math.max(0, onlineMs),
          active,
          xp,
          gp,
          drops: drops.length,
          activity: active ? bucketActivity(xp, drops) : null,
        });
      }
    }
    const xpBySkill: Record<string, number> = {};
    for (const b of buckets) {
      for (const [skill, xp] of Object.entries(b.xp))
        xpBySkill[skill] = (xpBySkill[skill] ?? 0) + xp;
    }
    return {
      id: span.id,
      start: span.start,
      end: span.end,
      onlineMs: sum(buckets.map((b) => b.onlineMs)),
      activeMs: sum(buckets.map((b) => (b.active ? b.onlineMs : 0))),
      xp: sum(Object.values(xpBySkill)),
      xpBySkill,
      gp: sum(buckets.map((b) => b.gp)),
      drops: sum(buckets.map((b) => b.drops)),
      kills: {},
      killsShared: false,
      main: null as MainActivity | null,
      buckets,
    } satisfies SessionMetrics;
  });
  attributeKills(sessions, input.kills);
  for (const s of sessions) s.main = mainActivity(s);
  return sessions;
}

/**
 * How long before a hiscores reading a session may have ended for the reading's kills to be its own.
 * The lookup after a session comes about 10 minutes after it (D-105), later when the sync is busy;
 * the daily lookup comes a day after the last one, so a reading this long after every session is the
 * daily one, and what it found was played outside RuneLite.
 */
export const KILL_READING_WINDOW_MS = 12 * 60 * MINUTE_MS;

/**
 * Gives each kill gain to the sessions that ended in (prevAt, at] and at most KILL_READING_WINDOW_MS
 * before the reading: the hiscores are read after a session ends, so the kills of that reading were
 * made in it. activity_scores keeps changes only, so prevAt (the last change) can be long before the
 * lookup before; the window is what keeps an old session from collecting kills made on mobile. With
 * several sessions in it the last one gets the kills and every one of them is marked `killsShared`
 * (they can't be told apart); with none (mobile play, D-105), the gain stays in period totals only.
 * Mutates `sessions`.
 */
export function attributeKills(sessions: SessionMetrics[], kills: readonly KillGain[]): void {
  for (const k of kills) {
    if (!(k.kills > 0)) continue;
    const after = Math.max(k.prevAt, k.at - KILL_READING_WINDOW_MS);
    const covered = sessions.filter((s) => s.end > after && s.end <= k.at);
    const last = covered.at(-1);
    if (!last) continue;
    last.kills[k.activity] = (last.kills[k.activity] ?? 0) + k.kills;
    if (covered.length > 1) for (const s of covered) s.killsShared = true;
  }
}

function mainActivity(s: SessionMetrics): MainActivity | null {
  const boss = topKey(s.kills);
  if (boss !== null) return { kind: 'boss', name: boss };
  const skill = topKey(s.xpBySkill);
  return skill === null ? null : { kind: 'skill', name: skill };
}

function bucketActivity(xp: Record<string, number>, drops: readonly Drop[]): string | null {
  let best: Drop | null = null;
  for (const d of drops) if (d.source && (best === null || d.value > best.value)) best = d;
  return best?.source ?? topKey(xp);
}

/** The key with the largest positive value (ties: the first in name order); null when none. */
function topKey(values: Record<string, number>): string | null {
  let best: string | null = null;
  for (const [key, value] of Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (value > 0 && (best === null || value > values[best]!)) best = key;
  }
  return best;
}

function floorBucket(ms: number): number {
  return Math.floor(ms / METRICS_BUCKET_MS) * METRICS_BUCKET_MS;
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

// --- Measures ------------------------------------------------------------------------------------

/** What to count: the measure, and for XP and kills the skills or bosses (null = all of them). */
export interface MeasureSelection {
  measure: MetricsMeasure;
  skills?: ReadonlySet<string> | null;
  bosses?: ReadonlySet<string> | null;
}

/** The session's total of the measure (active time in ms for `active`). */
export function sessionValue(s: SessionMetrics, sel: MeasureSelection): number {
  switch (sel.measure) {
    case 'xp':
      return selectedSum(s.xpBySkill, sel.skills);
    case 'gp':
      return s.gp;
    case 'kills':
      return selectedSum(s.kills, sel.bosses);
    case 'active':
      return s.activeMs;
  }
}

/**
 * The bucket's share of the measure. Kills aren't known per bucket: a session's kills are spread
 * evenly over its active buckets, which is what the heatmap colours by.
 */
export function bucketValue(b: MetricsBucket, s: SessionMetrics, sel: MeasureSelection): number {
  switch (sel.measure) {
    case 'xp':
      return selectedSum(b.xp, sel.skills);
    case 'gp':
      return b.gp;
    case 'kills': {
      if (!b.active) return 0;
      const active = activeBucketCount(s);
      return active === 0 ? 0 : selectedSum(s.kills, sel.bosses) / active;
    }
    case 'active':
      return b.active ? b.onlineMs : 0;
  }
}

const activeCounts = new WeakMap<SessionMetrics, number>();

function activeBucketCount(s: SessionMetrics): number {
  let count = activeCounts.get(s);
  if (count === undefined) {
    count = s.buckets.filter((b) => b.active).length;
    activeCounts.set(s, count);
  }
  return count;
}

/**
 * The rate a chart shows for an amount over a time: per hour for XP, GP and kills; for `active`, the
 * share of the time that was active (0…1). Null when there is no time.
 */
export function rateOf(sel: MeasureSelection, value: number, ms: number): number | null {
  if (!(ms > 0)) return null;
  return sel.measure === 'active' ? value / ms : (value / ms) * 3_600_000;
}

function selectedSum(values: Record<string, number>, keys: ReadonlySet<string> | null | undefined) {
  let total = 0;
  for (const [key, value] of Object.entries(values)) {
    if (!keys || keys.has(key)) total += value;
  }
  return total;
}

// --- Filters -------------------------------------------------------------------------------------

export interface SessionFilter {
  /** Shortest session kept. */
  minMs?: number | null;
  /** Local weekdays a session may start on, 0 = Monday … 6 = Sunday; null = any. */
  weekdays?: ReadonlySet<number> | null;
  /**
   * Local hours a session may start in: [from, to) in whole hours, wrapping past midnight when `from`
   * is after `to` (22 → 2 is late evening into the night); null = any.
   */
  hours?: { from: number; to: number } | null;
  /** The session's main activity (a boss or a skill name); null = any. */
  activity?: string | null;
}

/** The sessions that pass every part of the filter, judged by the local clock of their start. */
export function filterSessions(
  sessions: readonly SessionMetrics[],
  filter: SessionFilter,
  timezone: string,
): SessionMetrics[] {
  const clock = new LocalClockCache(timezone);
  return sessions.filter((s) => {
    if (filter.minMs && s.onlineMs < filter.minMs) return false;
    if (filter.activity && s.main?.name !== filter.activity) return false;
    if (!filter.weekdays && !filter.hours) return true;
    const local = clock.at(s.start);
    if (filter.weekdays && !filter.weekdays.has(local.weekday)) return false;
    if (filter.hours && !inHours(local.hour, filter.hours)) return false;
    return true;
  });
}

function inHours(hour: number, { from, to }: { from: number; to: number }): boolean {
  if (from === to) return true;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

// --- Summaries -----------------------------------------------------------------------------------

export interface SessionsSummary {
  sessions: number;
  onlineMs: number;
  activeMs: number;
  /** The measure over all sessions (active ms for `active`). */
  value: number;
}

export function summarizeSessions(
  sessions: readonly SessionMetrics[],
  sel: MeasureSelection,
): SessionsSummary {
  return {
    sessions: sessions.length,
    onlineMs: sum(sessions.map((s) => s.onlineMs)),
    activeMs: sum(sessions.map((s) => s.activeMs)),
    value: sum(sessions.map((s) => sessionValue(s, sel))),
  };
}

export interface SessionRecords {
  /** Ids of the record sessions; null when no session has any of it. */
  mostXp: string | null;
  mostGp: string | null;
  mostKills: string | null;
  longest: string | null;
}

export function sessionRecords(sessions: readonly SessionMetrics[]): SessionRecords {
  const best = (value: (s: SessionMetrics) => number): string | null => {
    let top: SessionMetrics | null = null;
    for (const s of sessions) if (value(s) > 0 && (top === null || value(s) > value(top))) top = s;
    return top?.id ?? null;
  };
  return {
    mostXp: best((s) => s.xp),
    mostGp: best((s) => s.gp),
    mostKills: best((s) => sum(Object.values(s.kills))),
    longest: best((s) => s.onlineMs),
  };
}

// --- Heatmap ---------------------------------------------------------------------------------------

export interface HeatCell {
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
  hour: number;
  onlineMs: number;
  activeMs: number;
  /** The measure in this cell (active ms for `active`). */
  value: number;
  /** Sessions with online time in this cell. */
  sessions: number;
}

/**
 * Weekday × hour of day in the viewer's time zone: online and active time and the measure in every
 * cell (7 × 24, Monday 00:00 first). Each bucket falls in the cell of its start.
 */
export function heatmap(
  sessions: readonly SessionMetrics[],
  sel: MeasureSelection,
  timezone: string,
): HeatCell[] {
  const cells: HeatCell[] = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let hour = 0; hour < 24; hour++) {
      cells.push({ weekday, hour, onlineMs: 0, activeMs: 0, value: 0, sessions: 0 });
    }
  }
  const clock = new LocalClockCache(timezone);
  for (const s of sessions) {
    const seen = new Set<number>();
    for (const b of s.buckets) {
      if (b.onlineMs <= 0) continue;
      const local = clock.at(b.at);
      const index = local.weekday * 24 + local.hour;
      const cell = cells[index]!;
      cell.onlineMs += b.onlineMs;
      if (b.active) cell.activeMs += b.onlineMs;
      cell.value += bucketValue(b, s, sel);
      if (!seen.has(index)) {
        seen.add(index);
        cell.sessions += 1;
      }
    }
  }
  return cells;
}

/**
 * The number a heatmap cell is coloured by: active minutes for `active`, else the measure per active
 * hour (null for a cell without active time).
 */
export function heatValue(cell: HeatCell, sel: MeasureSelection): number | null {
  if (sel.measure === 'active') return cell.activeMs / MINUTE_MS;
  return cell.activeMs > 0 ? (cell.value / cell.activeMs) * 3_600_000 : null;
}

// --- Rate through a session ------------------------------------------------------------------------

export interface RateStep {
  /** Minutes into the session where the step starts. */
  minute: number;
  /** Sessions that lasted through the whole step. */
  sessions: number;
  p25: number;
  median: number;
  p75: number;
}

/**
 * The rate of the measure by time into the session: for each step of `stepMs` (0–30 min, 30–60 min…),
 * the median and the middle half over the sessions that lasted the whole step. A rate is per online
 * hour, or the active share for `active`. Kills aren't known within a session, so they give no steps.
 */
export function rateThroughSession(
  sessions: readonly SessionMetrics[],
  sel: MeasureSelection,
  { stepMs = 30 * MINUTE_MS, maxSteps = 12 }: { stepMs?: number; maxSteps?: number } = {},
): RateStep[] {
  if (sel.measure === 'kills') return [];
  const out: RateStep[] = [];
  for (let k = 0; k < maxSteps; k++) {
    const rates: number[] = [];
    for (const s of sessions) {
      const from = s.start + k * stepMs;
      const to = from + stepMs;
      if (s.end < to) continue;
      let value = 0;
      for (const b of s.buckets) {
        const mid = b.at + METRICS_BUCKET_MS / 2;
        if (mid >= from && mid < to) value += bucketValue(b, s, sel);
      }
      const rate = rateOf(sel, value, stepMs);
      if (rate !== null) rates.push(sel.measure === 'active' ? Math.min(1, rate) : rate);
    }
    if (rates.length === 0) break;
    rates.sort((a, b) => a - b);
    out.push({
      minute: (k * stepMs) / MINUTE_MS,
      sessions: rates.length,
      p25: quantile(rates, 0.25),
      median: quantile(rates, 0.5),
      p75: quantile(rates, 0.75),
    });
  }
  return out;
}

/** The q-quantile of sorted values, interpolated between the two nearest. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

// --- Where the time goes ---------------------------------------------------------------------------

export interface TimeByActivity {
  /** Local days, oldest first: every day from the first to the last with active time. */
  days: string[];
  /** The activities with the most active time first (at most `maxActivities`, then "Other"). */
  series: { name: string; ms: number[] }[];
}

/** The name the rest of the activities are folded into. */
export const OTHER_ACTIVITY = 'Other';

/** Active time per activity (a bucket's `activity`) per local day. */
export function timeByActivity(
  sessions: readonly SessionMetrics[],
  timezone: string,
  maxActivities = 6,
): TimeByActivity {
  const clock = new LocalClockCache(timezone);
  const perDay = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();
  for (const s of sessions) {
    for (const b of s.buckets) {
      if (!b.active || b.activity === null) continue;
      const day = clock.at(b.at).day;
      const row = perDay.get(day) ?? new Map<string, number>();
      row.set(b.activity, (row.get(b.activity) ?? 0) + b.onlineMs);
      perDay.set(day, row);
      totals.set(b.activity, (totals.get(b.activity) ?? 0) + b.onlineMs);
    }
  }
  const days = calendarDays([...perDay.keys()]);
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const named = ranked.slice(0, maxActivities).map(([name]) => name);
  const rest = new Set(ranked.slice(maxActivities).map(([name]) => name));
  const series = named.map((name) => ({
    name,
    ms: days.map((day) => perDay.get(day)?.get(name) ?? 0),
  }));
  if (rest.size > 0) {
    series.push({
      name: OTHER_ACTIVITY,
      ms: days.map((day) => {
        let total = 0;
        for (const [name, ms] of perDay.get(day) ?? []) if (rest.has(name)) total += ms;
        return total;
      }),
    });
  }
  return { days, series };
}

/** Every YYYY-MM-DD from the earliest to the latest of `days`, in order. */
export function calendarDays(days: readonly string[]): string[] {
  const times = days.map((d) => Date.parse(`${d}T00:00:00Z`)).filter(Number.isFinite);
  if (times.length === 0) return [];
  const out: string[] = [];
  const last = Math.max(...times);
  for (let t = Math.min(...times); t <= last; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
