/**
 * The Metrics page of one boss of an account (D-108): its kill count and ranks, kills per period,
 * loot per kill, uniques and the kills since the last one, and the sessions it was killed in.
 *
 * Kills come from the hiscores (`hiscores`), loot from the plugin's loot events (`events`), sessions
 * need `activity`. A loot drop belongs to the boss when its source names it (isSameBoss); a unique is
 * a collection log entry within 10 seconds of such a drop, and its kill count is the one the plugin
 * attached to the entry (the "Your X kill count is" line it already parses).
 */
import {
  DAY_MS,
  LocalClockCache,
  attributeKills,
  buildSessions,
  calendarDays,
  isSameBoss,
  type HiscoreMode,
  type MetricsQuery,
  type Principal,
} from '@hub/core';
import type { DbOrTx } from '@hub/db';
import { sql } from 'drizzle-orm';
import { readSessions } from '../accounts/history';
import { loadVisibleAccount } from '../accounts/load';
import { loadHiscoresViews, type HiscoresActivityView } from '../hiscores/read';
import { resolveMetricsRange } from './range';
import { readDrops, readKillGains } from './read';

/** The step of the kills and loot bars: days up to 120 days, then weeks (local, from Monday). */
const WEEKLY_AFTER_DAYS = 120;
/** Uniques listed. */
export const MAX_UNIQUES = 50;
/** Top drops listed. */
export const TOP_DROPS = 10;

export interface BossPeriod {
  /** The local day (YYYY-MM-DD) the period starts. */
  start: string;
  kills: number;
  /** Loot from the boss; null without `events`. */
  gp: number | null;
}

export interface BossUnique {
  at: string;
  item: string | null;
  value: number | null;
  /** The kill count the plugin attached; null when it didn't. */
  killCount: number | null;
}

export interface BossSession {
  id: string;
  start: string;
  onlineMs: number;
  kills: number;
  /** The kills were read together with other sessions'. */
  shared: boolean;
  /** onlineMs ÷ kills; null for a shared reading (it can't be split). */
  msPerKill: number | null;
  gp: number | null;
}

export interface BossMetricsPage {
  account: { publicId: string; name: string };
  activity: string;
  /** The hiscores row; null when the account isn't listed for it (below 5 kills, or not yet read). */
  hiscore: Pick<HiscoresActivityView, 'score' | 'rank' | 'modeRank'> | null;
  /** The table modeRank is on (an iron account's); null when never read. */
  mode: HiscoreMode | null;
  fetchedAt: string | null;
  range: { from: string; to: string; preset: MetricsQuery['range'] };
  step: 'day' | 'week';
  /** Kills read in the range. */
  kills: number;
  /** Loot from the boss in the range; null without `events`. */
  gp: number | null;
  drops: number | null;
  /** gp ÷ kills; null without both. */
  gpPerKill: number | null;
  periods: BossPeriod[];
  /** Highest drops in the range, highest first; null without `events`. */
  topDrops: { at: string; value: number }[] | null;
  /** Newest first, all time; null without `events`. */
  uniques: BossUnique[] | null;
  /** Current kill count minus the one of the last unique; null when either is unknown. */
  killsSinceUnique: number | null;
  /** Sessions in the range with kills of it, newest first; null without `activity`. */
  sessions: BossSession[] | null;
}

/**
 * The boss page, or null when the account isn't visible or the viewer can't read its `hiscores`
 * (the page answers 404 either way).
 */
export async function getBossMetrics(
  db: DbOrTx,
  viewer: Principal,
  publicId: string,
  activity: string,
  query: Pick<MetricsQuery, 'range' | 'from' | 'to'>,
  opts: { now: Date; timezone: string },
): Promise<BossMetricsPage | null> {
  const entry = await loadVisibleAccount(db, viewer, publicId);
  if (!entry || !entry.access.categories.has('hiscores')) return null;
  const { account } = entry;
  const events = entry.access.categories.has('events');
  const activityOk = entry.access.categories.has('activity');
  const window = resolveMetricsRange(query, opts.now, opts.timezone);
  const range = { from: window.from, to: window.to };

  const view = (await loadHiscoresViews(db, [account])).get(account.id);
  const row = view?.activities.find((a) => a.activity === activity) ?? null;
  const kills = await readKillGains(db, [account.id], range, [activity]);
  const drops = events
    ? (await readDrops(db, account.id, range)).filter((d) => isSameBoss(activity, d.source))
    : null;

  const step =
    (range.to.getTime() - range.from.getTime()) / DAY_MS > WEEKLY_AFTER_DAYS ? 'week' : 'day';
  const clock = new LocalClockCache(opts.timezone);
  const periodOf = (at: number) => {
    const local = clock.at(at);
    if (step === 'day') return local.day;
    const t = Date.parse(`${local.day}T00:00:00Z`) - local.weekday * DAY_MS;
    return new Date(t).toISOString().slice(0, 10);
  };
  const byPeriod = new Map<string, { kills: number; gp: number }>();
  const add = (at: number, k: number, gp: number) => {
    const key = periodOf(at);
    const p = byPeriod.get(key) ?? { kills: 0, gp: 0 };
    p.kills += k;
    p.gp += gp;
    byPeriod.set(key, p);
  };
  for (const k of kills) add(k.at, k.kills, 0);
  for (const d of drops ?? []) add(d.at, 0, d.value);
  const starts = [periodOf(range.from.getTime()), periodOf(range.to.getTime())];
  const days = calendarDays(starts);
  const periodStarts = step === 'day' ? days : days.filter((_, i) => i % 7 === 0);
  const periods = periodStarts.map((start) => ({
    start,
    kills: byPeriod.get(start)?.kills ?? 0,
    gp: drops ? (byPeriod.get(start)?.gp ?? 0) : null,
  }));

  const totalKills = kills.reduce((s, k) => s + k.kills, 0);
  const gp = drops ? drops.reduce((s, d) => s + d.value, 0) : null;
  const uniques = events ? await readUniques(db, account.id, activity) : null;
  const lastWithKc = uniques?.find((u) => u.killCount !== null);
  const killsSinceUnique =
    row && lastWithKc?.killCount != null ? Math.max(0, row.score - lastWithKc.killCount) : null;

  let sessions: BossSession[] | null = null;
  if (activityOk) {
    const spans = (await readSessions(db, account.id, range)).map((s) => ({
      id: s.id,
      start: Date.parse(s.startedAt),
      end: Date.parse(s.endedAt ?? s.lastSeenAt),
    }));
    const built = buildSessions({
      spans,
      gains: [],
      drops: drops ?? [],
      kills: [],
      lootActive: false,
    });
    attributeKills(built, kills);
    sessions = built
      .filter((s) => (s.kills[activity] ?? 0) > 0)
      .map((s) => {
        const k = s.kills[activity]!;
        return {
          id: s.id,
          start: new Date(s.start).toISOString(),
          onlineMs: s.onlineMs,
          kills: k,
          shared: s.killsShared,
          msPerKill: s.killsShared ? null : s.onlineMs / k,
          gp: drops ? s.gp : null,
        };
      })
      .reverse();
  }

  return {
    account: { publicId: account.publicId, name: account.name },
    activity,
    hiscore: row ? { score: row.score, rank: row.rank, modeRank: row.modeRank } : null,
    mode: view?.mode ?? null,
    fetchedAt: view?.fetchedAt ?? null,
    range: { from: range.from.toISOString(), to: range.to.toISOString(), preset: window.preset },
    step,
    kills: totalKills,
    gp,
    drops: drops ? drops.length : null,
    gpPerKill: gp !== null && totalKills > 0 ? gp / totalKills : null,
    periods,
    topDrops: drops
      ? [...drops]
          .sort((a, b) => b.value - a.value)
          .slice(0, TOP_DROPS)
          .map((d) => ({ at: new Date(d.at).toISOString(), value: d.value }))
      : null,
    uniques,
    killsSinceUnique,
    sessions,
  };
}

/**
 * Collection log entries of the account that came within 10 seconds of a loot drop from the boss,
 * newest first (at most MAX_UNIQUES). The nearest drop in time decides the source.
 */
async function readUniques(db: DbOrTx, accountId: number, activity: string): Promise<BossUnique[]> {
  const result = await db.execute<{
    occurred_at: Date;
    value_gp: number | null;
    item: string | null;
    kc: string | null;
    source: string | null;
  }>(sql`
    SELECT c.occurred_at, c.value_gp, c.data #>> '{data,itemName}' AS item,
           c.data #>> '{data,killCount}' AS kc, l.source
    FROM events c
    CROSS JOIN LATERAL (
      SELECT ev.data #>> '{data,source,text}' AS source FROM events ev
      WHERE ev.account_id = c.account_id AND ev.type = 'loot'
        AND ev.occurred_at BETWEEN c.occurred_at - interval '10 seconds'
                               AND c.occurred_at + interval '10 seconds'
      ORDER BY abs(extract(epoch FROM ev.occurred_at - c.occurred_at))
      LIMIT 1
    ) l
    WHERE c.account_id = ${accountId} AND c.type = 'collection_log'
    ORDER BY c.occurred_at DESC
    LIMIT 5000`);
  const out: BossUnique[] = [];
  for (const r of result.rows) {
    if (!isSameBoss(activity, r.source)) continue;
    const kc = r.kc !== null && /^\d{1,9}$/.test(r.kc) ? Number(r.kc) : null;
    out.push({
      at: new Date(r.occurred_at).toISOString(),
      item: typeof r.item === 'string' ? r.item.slice(0, 100) : null,
      value: r.value_gp === null ? null : Number(r.value_gp),
      killCount: kc,
    });
    if (out.length >= MAX_UNIQUES) break;
  }
  return out;
}
