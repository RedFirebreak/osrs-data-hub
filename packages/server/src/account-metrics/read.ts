/**
 * The rows Metrics is built from (D-106), read without a permission check: the callers in this folder
 * resolve the account and its categories first and only call the readers a viewer may see.
 *
 * Nothing here is stored for Metrics: every number is derived on read from what the hub keeps anyway
 * (xp_samples and its rollups, play_sessions, events, activity_scores, wealth_daily).
 */
import {
  OVERALL,
  describeEvent,
  floorTo,
  type DescribableEvent,
  type Drop,
  type KillGain,
  type XpGain,
} from '@hub/core';
import type { DbOrTx } from '@hub/db';
import { sql } from 'drizzle-orm';
import { RESOLUTION_MS, loadXpAt, type Resolution } from '../accounts/xp';

/** A closed set: safe for sql.raw. */
const TIER_SOURCE: Readonly<Record<Resolution, string>> = {
  '5m': 'xp_samples',
  '1h': 'xp_hourly',
  '1d': 'xp_daily',
};

export interface Range {
  from: Date;
  to: Date;
}

/**
 * XP gained per skill per bucket of a tier in [from, to]: each row minus the skill's value before it
 * (xp_at at the start of `from`'s bucket for the first one). A skill with nothing before `from` starts its series at its first
 * row, which is not a gain (the same baseline rule as computeGains). Overall is left out: it is the
 * sum of the others. On the 5-minute tier, rows the hiscores filled in (hiscore_xp_fills, D-105) are
 * marked `fromHiscores`.
 */
export async function readXpGains(
  db: DbOrTx,
  accountId: number,
  range: Range,
  resolution: Resolution = '5m',
): Promise<XpGain[]> {
  if (range.to.getTime() < range.from.getTime()) return [];
  // From the start of the bucket `from` falls in, so that bucket's gain isn't folded into the next.
  const start = floorTo(range.from, RESOLUTION_MS[resolution]);
  const before = (await loadXpAt(db, [accountId], start)).get(accountId) ?? new Map();
  const fills =
    resolution === '5m'
      ? sql`EXISTS (SELECT 1 FROM hiscore_xp_fills f
          WHERE f.account_id = x.account_id AND f.skill_id = x.skill_id AND f.bucket = x.bucket)`
      : sql`false`;
  const result = await db.execute<{ skill: string; bucket: Date; xp: number; filled: boolean }>(sql`
    SELECT s.name AS skill, x.bucket, x.xp, ${fills} AS filled
    FROM ${sql.raw(TIER_SOURCE[resolution])} x
    JOIN skills s ON s.id = x.skill_id
    WHERE x.account_id = ${accountId}
      AND s.name <> ${OVERALL}
      AND x.bucket >= ${start.toISOString()}::timestamptz
      AND x.bucket <= ${range.to.toISOString()}::timestamptz
    ORDER BY s.name, x.bucket`);
  const out: XpGain[] = [];
  const last = new Map<string, number>(before);
  for (const r of result.rows) {
    const xp = Number(r.xp);
    const prev = last.get(r.skill);
    last.set(r.skill, xp);
    if (prev === undefined || xp <= prev) continue;
    out.push({
      at: new Date(r.bucket).getTime(),
      skill: r.skill,
      xp: xp - prev,
      fromHiscores: r.filled === true,
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Most drops one read returns (the newest win); a year of busy bossing stays well below it. */
export const MAX_DROPS = 50_000;

/**
 * Loot drops (`loot` and `pk_loot` with a value, not from a special world: as the loot leaderboard
 * counts them, D-94) that happened in [from, to], oldest first, with the source the plugin named.
 */
export async function readDrops(db: DbOrTx, accountId: number, range: Range): Promise<Drop[]> {
  const result = await db.execute<{ occurred_at: Date; value_gp: number; source: unknown }>(sql`
    SELECT occurred_at, value_gp, data #>> '{data,source,text}' AS source
    FROM events
    WHERE account_id = ${accountId}
      AND type IN ('loot', 'pk_loot') AND value_gp IS NOT NULL AND NOT special_world
      AND occurred_at >= ${range.from.toISOString()}::timestamptz
      AND occurred_at <= ${range.to.toISOString()}::timestamptz
    ORDER BY occurred_at DESC
    LIMIT ${MAX_DROPS}`);
  return result.rows
    .map((r) => ({
      at: new Date(r.occurred_at).getTime(),
      value: Number(r.value_gp),
      source: typeof r.source === 'string' && r.source.trim() !== '' ? r.source.trim() : null,
    }))
    .reverse();
}

export interface TimelineMarker {
  at: string;
  /** The stored event type. */
  type: TimelineMarkerType;
  /** The event's feed line ("… received Abyssal whip (2.1M) from Abyssal demon"). */
  line: string;
  /** The loot value, for sizing a drop's marker. */
  value: number | null;
}

/** The events a session timeline marks. */
const MARKER_TYPES = ['loot', 'pk_loot', 'level_up', 'death', 'collection_log'] as const;
export type TimelineMarkerType = (typeof MARKER_TYPES)[number];
/** Most markers on one timeline. */
export const MAX_MARKERS = 500;

/**
 * The events a session timeline marks in [from, to], oldest first, each with its feed line. Lines are
 * built from the stored event the way the feed builds them; a death's line never carries its
 * location (describeEvent doesn't write one).
 */
export async function readMarkers(
  db: DbOrTx,
  account: { id: number; name: string },
  range: Range,
): Promise<TimelineMarker[]> {
  const result = await db.execute<{
    type: TimelineMarkerType;
    occurred_at: Date;
    value_gp: number | null;
    skill: string | null;
    level: number | null;
    tier: string | null;
    points: number | null;
    data: unknown;
  }>(sql`
    SELECT type, occurred_at, value_gp, skill, level, tier, points, data
    FROM events
    WHERE account_id = ${account.id}
      AND type = ANY(${sql.param([...MARKER_TYPES])}::text[])
      AND NOT special_world
      AND occurred_at >= ${range.from.toISOString()}::timestamptz
      AND occurred_at <= ${range.to.toISOString()}::timestamptz
    ORDER BY occurred_at
    LIMIT ${MAX_MARKERS}`);
  return result.rows.map((r) => {
    const event: DescribableEvent = {
      type: r.type,
      valueGp: r.value_gp === null ? null : Number(r.value_gp),
      skill: r.skill,
      level: r.level,
      tier: r.tier,
      points: r.points,
      data: r.data,
    };
    return {
      at: new Date(r.occurred_at).toISOString(),
      type: r.type,
      line: describeEvent(account.name, event).line,
      value: event.valueGp,
    };
  });
}

/** A kill gain of one account (readKillGains for several). */
export interface AccountKillGain extends KillGain {
  accountId: number;
}

/**
 * Every rise of a hiscores score read in (from, to] (D-105's activity_scores): a row minus the row
 * before it in its series. Baseline rows start a series and are never a gain, so an account's first
 * reading, the first after a rename and a score that just appeared add nothing (the leaderboard
 * baseline rule). Scores that went down (rank-like rows such as "LMS - Rank") are left out.
 */
export async function readKillGains(
  db: DbOrTx,
  accountIds: readonly number[],
  range: Range,
  activities?: readonly string[],
): Promise<AccountKillGain[]> {
  if (accountIds.length === 0 || activities?.length === 0) return [];
  const activityFilter =
    activities === undefined
      ? sql`true`
      : sql`activity = ANY(${sql.param([...activities])}::text[])`;
  const result = await db.execute<{
    account_id: number;
    activity: string;
    read_at: Date;
    prev_read_at: Date;
    gain: number;
  }>(sql`
    SELECT account_id, activity, read_at, prev_read_at, score - prev_score AS gain
    FROM (
      SELECT account_id, activity, read_at, score, baseline,
             lag(score) OVER w AS prev_score, lag(read_at) OVER w AS prev_read_at
      FROM activity_scores
      WHERE account_id = ANY(${sql.param([...new Set(accountIds)])}::int[])
        AND ${activityFilter}
        AND read_at <= ${range.to.toISOString()}::timestamptz
      WINDOW w AS (PARTITION BY account_id, activity ORDER BY read_at)
    ) r
    WHERE NOT baseline AND prev_score IS NOT NULL AND score > prev_score
      AND read_at > ${range.from.toISOString()}::timestamptz
    ORDER BY read_at`);
  return result.rows.map((r) => ({
    accountId: r.account_id,
    activity: r.activity,
    at: new Date(r.read_at).getTime(),
    prevAt: new Date(r.prev_read_at).getTime(),
    kills: Number(r.gain),
  }));
}

/**
 * Carried wealth at the end of the range minus at its start (wealth_daily, UTC days: the last value
 * of the range's last day with data minus that of the last day before the range, or of its first day
 * when there is none before). Null without any day.
 */
export async function readWealthChange(
  db: DbOrTx,
  accountId: number,
  range: Range,
): Promise<number | null> {
  const result = await db.execute<{ start: number | null; end: number | null }>(sql`
    SELECT
      COALESCE(
        (SELECT last_value FROM wealth_daily
          WHERE account_id = ${accountId} AND day < ${utcDay(range.from)}::date
          ORDER BY day DESC LIMIT 1),
        (SELECT last_value FROM wealth_daily
          WHERE account_id = ${accountId} AND day >= ${utcDay(range.from)}::date
            AND day <= ${utcDay(range.to)}::date
          ORDER BY day ASC LIMIT 1)) AS start,
      (SELECT last_value FROM wealth_daily
        WHERE account_id = ${accountId} AND day >= ${utcDay(range.from)}::date
          AND day <= ${utcDay(range.to)}::date
        ORDER BY day DESC LIMIT 1) AS end`);
  const row = result.rows[0];
  if (!row || row.start === null || row.end === null) return null;
  return Number(row.end) - Number(row.start);
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
