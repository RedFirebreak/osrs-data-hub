/**
 * XP read models: gains and chart series (handoff §9 XP semantics).
 *
 * XP is a counter that only goes up, so every tier stores the LAST value per bucket (xp_samples:
 * 5 min, change-only; xp_hourly and xp_daily: continuous aggregates, D-23). A bucket's value is the XP
 * at the END of the bucket, which makes xp_at exact at bucket edges on every tier:
 *
 *   xp_at(t)      = the value of the last bucket that ended at or before t;
 *   gains(a, b)   = xp_at(b) − xp_at(a), and "now" is latest_state.skills.
 *
 * xp_at looks the value up in xp_samples first: the raw tier is complete for as long as it is kept
 * (retention drops whole old chunks only), and an index probe there costs microseconds. Only a pair
 * with no raw sample before t (its last change predates the raw retention) falls back to xp_hourly,
 * which is kept forever. Querying xp_hourly first would read and sort every hourly row of the pair:
 * the planner can't push ORDER BY … LIMIT 1 into a real-time aggregate's UNION ALL (measured
 * ~1.3 ms per lookup at 1500 hourly rows, against ~0.01 ms on the raw hypertable).
 * Special-world payloads never write XP samples, so gains never include them.
 */
import { OVERALL, floorTo, overallXp, type Principal } from '@hub/core';
import { latestState, skills as skillsTable, type DbOrTx } from '@hub/db';
import { and, inArray, isNotNull, sql } from 'drizzle-orm';
import { loadVisibleAccount } from './load';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export type Resolution = '5m' | '1h' | '1d';

export const RESOLUTION_MS: Readonly<Record<Resolution, number>> = {
  '5m': 5 * MINUTE_MS,
  '1h': HOUR_MS,
  '1d': DAY_MS,
};

/** The table (or continuous aggregate) behind each resolution. A closed set: safe for sql.raw. */
const RESOLUTION_SOURCE: Readonly<Record<Resolution, string>> = {
  '5m': 'xp_samples',
  '1h': 'xp_hourly',
  '1d': 'xp_daily',
};

/** More buckets than this per series makes the request use the next coarser resolution. */
export const MAX_SERIES_POINTS = 5000;
/** Skills per XP series request; more are ignored. */
export const MAX_SERIES_SKILLS = 30;

/** XP by skill name ("Overall" included). */
export type XpBySkill = Map<string, number>;
/** XP by account id, then skill name. */
export type XpByAccount = Map<number, XpBySkill>;

/**
 * The resolution for a range: 'auto' picks 5m up to 7 days (the raw tier), 1h up to 90 days and 1d
 * beyond (handoff §9). An explicit resolution is kept unless the range would have more than
 * MAX_SERIES_POINTS buckets at it, in which case the next coarser one is used (the response says
 * which), so a 5-minute request over a year can't return 100k points per skill. Unknown values are
 * treated as 'auto'. By span only: seriesResolution also moves 5m to 1h for a range older than the
 * raw retention (rawTierStart).
 */
export function pickResolution(from: Date, to: Date, requested: Resolution | 'auto'): Resolution {
  const span = Math.max(0, to.getTime() - from.getTime());
  let resolution: Resolution = Object.hasOwn(RESOLUTION_MS, requested)
    ? (requested as Resolution)
    : span <= 7 * DAY_MS
      ? '5m'
      : span <= 90 * DAY_MS
        ? '1h'
        : '1d';
  while (resolution !== '1d' && span / RESOLUTION_MS[resolution] > MAX_SERIES_POINTS) {
    resolution = resolution === '5m' ? '1h' : '1d';
  }
  return resolution;
}

/**
 * Where xp_samples is complete from: now − the retention policy's drop_after, or null without a
 * retention policy (nothing is ever dropped). Retention drops whole chunks older than that, so raw
 * samples before it may be gone while xp_hourly and xp_daily keep that history (TSDB-1). The policy
 * is the worker's reconciliation of XP_RAW_RETENTION_DAYS (D-40), so this follows the configuration
 * without the read model knowing it.
 */
async function rawTierStart(db: DbOrTx): Promise<Date | null> {
  const result = await db.execute<{ start: Date | string | null }>(sql`
    SELECT max(now() - (j.config->>'drop_after')::interval) AS start
    FROM timescaledb_information.jobs j
    WHERE j.proc_name = 'policy_retention' AND j.hypertable_name = 'xp_samples'
      AND j.hypertable_schema = current_schema()`);
  const start = result.rows[0]?.start;
  return start === null || start === undefined ? null : new Date(start);
}

/**
 * xp_at(t) for the given accounts: the value of the last bucket that ended at or before t, for every
 * skill (or only `skills`). From xp_samples (bucket ≤ t − 5 min); for a pair without a raw sample by
 * then, from xp_hourly (bucket ≤ t − 1 h). The hourly LATERAL carries `r.xp IS NULL` inside, which the
 * planner turns into a one-time filter, so it only runs for those pairs.
 */
export async function loadXpAt(
  db: DbOrTx,
  accountIds: readonly number[],
  t: Date,
  skills?: readonly string[],
): Promise<XpByAccount> {
  const out: XpByAccount = new Map();
  if (accountIds.length === 0 || skills?.length === 0) return out;
  const at = t.toISOString();
  const skillFilter =
    skills === undefined ? sql`true` : sql`s.name = ANY(${sql.param([...skills])}::text[])`;
  const result = await db.execute<XpRow>(sql`
    SELECT a.id AS account_id, s.name AS skill, COALESCE(r.xp, h.xp) AS xp
    FROM unnest(${sql.param([...new Set(accountIds)])}::int[]) AS a(id)
    CROSS JOIN skills s
    LEFT JOIN LATERAL (
      SELECT x.xp FROM xp_samples x
      WHERE x.account_id = a.id AND x.skill_id = s.id
        AND x.bucket <= ${at}::timestamptz - interval '5 minutes'
      ORDER BY x.bucket DESC
      LIMIT 1
    ) r ON true
    LEFT JOIN LATERAL (
      SELECT x.xp FROM xp_hourly x
      WHERE r.xp IS NULL AND x.account_id = a.id AND x.skill_id = s.id
        AND x.bucket <= ${at}::timestamptz - interval '1 hour'
      ORDER BY x.bucket DESC
      LIMIT 1
    ) h ON true
    WHERE ${skillFilter} AND COALESCE(r.xp, h.xp) IS NOT NULL`);
  addRows(out, result.rows);
  return out;
}

interface XpRow extends Record<string, unknown> {
  account_id: number;
  skill: string;
  xp: number;
}

function addRows(out: XpByAccount, rows: readonly XpRow[]): void {
  for (const r of rows) {
    const bySkill = out.get(r.account_id) ?? new Map<string, number>();
    bySkill.set(r.skill, Number(r.xp));
    out.set(r.account_id, bySkill);
  }
}

/**
 * The first known XP of each (account, skill) pair after `from`: the baseline for pairs with no sample
 * before `from` (an account or skill first seen inside the period). Normally the first raw sample
 * (bucket ending after `from`); when xp_hourly has an earlier hour than that sample's, the raw tier
 * has lost the start (raw retention shorter than the period) and the first hourly value is the
 * earliest value the hub still has. The hourly lookup only covers the hours before the raw sample's,
 * so it reads nothing in the normal case.
 */
async function loadFirstXpAfter(
  db: DbOrTx,
  pairs: readonly { accountId: number; skill: string }[],
  from: Date,
): Promise<XpByAccount> {
  const out: XpByAccount = new Map();
  if (pairs.length === 0) return out;
  const at = from.toISOString();
  const result = await db.execute<FirstRow>(sql`
    SELECT p.account_id, p.skill, r.xp AS raw_xp, h.xp AS hourly_xp
    FROM unnest(${sql.param(pairs.map((p) => p.accountId))}::int[],
                ${sql.param(pairs.map((p) => p.skill))}::text[]) AS p(account_id, skill)
    JOIN skills s ON s.name = p.skill
    LEFT JOIN LATERAL (
      SELECT x.xp, x.bucket FROM xp_samples x
      WHERE x.account_id = p.account_id AND x.skill_id = s.id
        AND x.bucket > ${at}::timestamptz - interval '5 minutes'
      ORDER BY x.bucket ASC
      LIMIT 1
    ) r ON true
    LEFT JOIN LATERAL (
      SELECT x.xp FROM xp_hourly x
      WHERE x.account_id = p.account_id AND x.skill_id = s.id
        AND x.bucket > ${at}::timestamptz - interval '1 hour'
        AND x.bucket < COALESCE(time_bucket(interval '1 hour', r.bucket), 'infinity')
      ORDER BY x.bucket ASC
      LIMIT 1
    ) h ON true`);
  const rows: XpRow[] = [];
  for (const r of result.rows) {
    const xp = r.hourly_xp ?? r.raw_xp;
    if (xp !== null) rows.push({ account_id: r.account_id, skill: r.skill, xp });
  }
  addRows(out, rows);
  return out;
}

interface FirstRow extends Record<string, unknown> {
  account_id: number;
  skill: string;
  raw_xp: number | null;
  hourly_xp: number | null;
}

/**
 * A latest_state.skills value as stored ({"Attack": {"xp": 1, "level": 1}, …}), keeping only entries
 * with a finite xp and level; null when it isn't an object. Never contains "Overall" (derived).
 */
export function parseSkills(value: unknown): Record<string, { xp: number; level: number }> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: Record<string, { xp: number; level: number }> = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (name === OVERALL || typeof entry !== 'object' || entry === null) continue;
    const { xp, level } = entry as { xp?: unknown; level?: unknown };
    if (typeof xp === 'number' && Number.isFinite(xp) && typeof level === 'number') {
      if (Number.isFinite(level)) out[name] = { xp, level };
    }
  }
  return out;
}

/** XP by skill name from parsed skills, plus the derived Overall (Σ xp). */
export function xpBySkill(skills: Record<string, { xp: number }>): XpBySkill {
  const out: XpBySkill = new Map();
  for (const [name, { xp }] of Object.entries(skills)) out.set(name, xp);
  out.set(OVERALL, overallXp(skills));
  return out;
}

/** Parsed latest_state.skills by account id (accounts that never sent stats are absent). */
export async function loadCurrentSkills(
  db: DbOrTx,
  accountIds: readonly number[],
): Promise<Map<number, Record<string, { xp: number; level: number }>>> {
  const out = new Map<number, Record<string, { xp: number; level: number }>>();
  if (accountIds.length === 0) return out;
  const rows = await db
    .select({ accountId: latestState.accountId, skills: latestState.skills })
    .from(latestState)
    .where(
      and(inArray(latestState.accountId, [...accountIds]), isNotNull(latestState.skillsUpdatedAt)),
    );
  for (const row of rows) {
    const parsed = parseSkills(row.skills);
    if (parsed !== null) out.set(row.accountId, parsed);
  }
  return out;
}

/** "Now" for gains: XP by skill (Overall included) from latest_state.skills. */
export async function loadCurrentXp(
  db: DbOrTx,
  accountIds: readonly number[],
): Promise<XpByAccount> {
  const out: XpByAccount = new Map();
  for (const [id, skills] of await loadCurrentSkills(db, accountIds))
    out.set(id, xpBySkill(skills));
  return out;
}

/**
 * gains(from, end) for every skill in `end` (XP at the end of the period, e.g. loadCurrentXp):
 * end − xp_at(from), where a pair with no sample before `from` uses its first sample after it as the
 * baseline. Negative results (which XP can't produce) clamp to 0, as does a pair without any sample.
 */
export async function computeGains(
  db: DbOrTx,
  from: Date,
  end: XpByAccount,
): Promise<Map<number, Map<string, number>>> {
  const skillNames = new Set<string>();
  for (const bySkill of end.values()) for (const skill of bySkill.keys()) skillNames.add(skill);
  const start = await loadXpAt(db, [...end.keys()], from, [...skillNames]);
  const missing: { accountId: number; skill: string }[] = [];
  for (const [accountId, bySkill] of end) {
    for (const skill of bySkill.keys()) {
      if (!start.get(accountId)?.has(skill)) missing.push({ accountId, skill });
    }
  }
  const first = await loadFirstXpAfter(db, missing, from);
  const out = new Map<number, Map<string, number>>();
  for (const [accountId, bySkill] of end) {
    const gains = new Map<string, number>();
    for (const [skill, xp] of bySkill) {
      const base = start.get(accountId)?.get(skill) ?? first.get(accountId)?.get(skill);
      gains.set(skill, base === undefined ? 0 : Math.max(0, xp - base));
    }
    out.set(accountId, gains);
  }
  return out;
}

/**
 * XP gained per skill ("Overall" included) between `from` and `to` (default: now, from
 * latest_state.skills), per handoff §9: gains(a, b) = xp_at(b) − xp_at(a). A skill without a sample
 * before `from` uses its earliest sample as the baseline; negative results clamp to 0. Empty when the
 * account never sent stats. No permission check: callers pass an account the viewer may see stats of.
 */
export async function getGains(
  db: DbOrTx,
  accountId: number,
  opts: { from: Date; to?: Date },
): Promise<Map<string, number>> {
  assertValidDate(opts.from, 'from');
  if (opts.to !== undefined) assertValidDate(opts.to, 'to');
  const end =
    opts.to === undefined
      ? await loadCurrentXp(db, [accountId])
      : await loadXpAt(db, [accountId], opts.to);
  const gains = await computeGains(db, opts.from, end);
  return gains.get(accountId) ?? new Map();
}

export interface XpSeries {
  resolution: Resolution;
  /** One entry per requested known skill, in request order; points are [ISO bucket start, xp]. */
  series: { skill: string; points: [string, number][] }[];
}

/**
 * XP chart data for one account (stats category required, else null; also null when the account
 * isn't visible): readXpSeries at seriesResolution, for the requested skills the hub knows. Unknown
 * skill names are left out; at most MAX_SERIES_SKILLS skills are read. An Invalid Date is a
 * RangeError before anything is read.
 */
export async function getXpSeries(
  db: DbOrTx,
  viewer: Principal,
  publicId: string,
  opts: { skills: readonly string[]; from: Date; to: Date; resolution: Resolution | 'auto' },
): Promise<XpSeries | null> {
  assertValidDate(opts.from, 'from');
  assertValidDate(opts.to, 'to');
  const found = await loadVisibleAccount(db, viewer, publicId);
  if (!found || !found.access.categories.has('stats')) return null;
  const resolution = await seriesResolution(db, opts.from, opts.to, opts.resolution);
  const skills = await knownSkills(db, opts.skills);
  return readXpSeries(db, found.account.id, { skills, from: opts.from, to: opts.to, resolution });
}

/**
 * The resolution a series request is read at: pickResolution, except that 5m becomes 1h when the
 * range starts before rawTierStart (the handoff's "5 min for ranges up to 7 days" assumes they are
 * within the raw tier; an old week would otherwise chart nothing). It doesn't depend on the account,
 * so a request for several accounts resolves it once.
 */
export async function seriesResolution(
  db: DbOrTx,
  from: Date,
  to: Date,
  requested: Resolution | 'auto',
): Promise<Resolution> {
  const resolution = pickResolution(from, to, requested);
  if (resolution !== '5m') return resolution;
  const rawStart = await rawTierStart(db);
  const start = floorTo(from, RESOLUTION_MS['5m']);
  return rawStart !== null && start.getTime() < rawStart.getTime() ? '1h' : resolution;
}

/** A series request as readXpSeries takes it; nothing in it depends on the account. */
export interface XpSeriesRequest {
  /** Skill names as the hub stores them, without duplicates; a name it doesn't know charts nothing. */
  skills: readonly string[];
  from: Date;
  to: Date;
  /** The resolution to read at (seriesResolution). */
  resolution: Resolution;
}

/**
 * XP chart data for one account, without a permission check: the caller may read the account's
 * `stats`. The source is xp_samples (5m), xp_hourly (1h) or xp_daily (1d, UTC days). The range
 * starts at `from` floored to the resolution, so a bucket that straddles `from` is included, and
 * ends with the bucket that starts at or before `to`.
 *
 * Every tier is change-only (a bucket exists only where the XP changed), so the value in effect when
 * the range starts, xp_at(start), is prepended as a point at the range start, unless a bucket starts
 * exactly there: charts then begin at the right value instead of at the first change.
 */
export async function readXpSeries(
  db: DbOrTx,
  accountId: number,
  opts: XpSeriesRequest,
): Promise<XpSeries> {
  const { resolution } = opts;
  const names = [...opts.skills];
  if (names.length === 0 || opts.to.getTime() < opts.from.getTime()) {
    return { resolution, series: names.map((skill) => ({ skill, points: [] })) };
  }
  const start = floorTo(opts.from, RESOLUTION_MS[resolution]);
  const carried = await loadXpAt(db, [accountId], start, names);
  const rows = await db.execute<SeriesRow>(sql`
    SELECT s.name AS skill, x.bucket, x.xp
    FROM ${sql.raw(RESOLUTION_SOURCE[resolution])} x
    JOIN skills s ON s.id = x.skill_id
    WHERE x.account_id = ${accountId}
      AND s.name = ANY(${sql.param(names)}::text[])
      AND x.bucket >= ${start.toISOString()}::timestamptz
      AND x.bucket <= ${opts.to.toISOString()}::timestamptz
    ORDER BY s.name, x.bucket`);

  const points = new Map<string, [string, number][]>(names.map((n) => [n, []]));
  for (const r of rows.rows) {
    points.get(r.skill)?.push([new Date(r.bucket).toISOString(), Number(r.xp)]);
  }
  const startIso = start.toISOString();
  const carriedXp = carried.get(accountId);
  return {
    resolution,
    series: names.map((skill) => {
      const list = points.get(skill) ?? [];
      const before = carriedXp?.get(skill);
      if (before !== undefined && list[0]?.[0] !== startIso) list.unshift([startIso, before]);
      return { skill, points: list };
    }),
  };
}

interface SeriesRow extends Record<string, unknown> {
  skill: string;
  bucket: Date;
  xp: number;
}

/** The requested names that exist in `skills`, deduplicated, in request order, capped. */
async function knownSkills(db: DbOrTx, requested: readonly unknown[]): Promise<string[]> {
  const wanted = [...new Set(requested.filter((s): s is string => typeof s === 'string'))].slice(
    0,
    MAX_SERIES_SKILLS,
  );
  if (wanted.length === 0) return [];
  const rows = await db
    .select({ name: skillsTable.name })
    .from(skillsTable)
    .where(inArray(skillsTable.name, wanted));
  const known = new Set(rows.map((r) => r.name));
  return wanted.filter((name) => known.has(name));
}

/** Throws a RangeError for an Invalid Date (a caller bug: routes validate their query strings). */
export function assertValidDate(date: Date, name: string): void {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new RangeError(`${name} is not a valid date`);
  }
}
