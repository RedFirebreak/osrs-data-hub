/**
 * GET /accounts/{id}/progress (D-139): the Progress page of one account (D-106) as a read model, the
 * REST twin of the MCP tool `progress`. It wraps the page's own model (getAccountMetrics), loaded
 * with the key as the restriction (D-70, as the collection log does, D-131), so a user key sees what
 * its creator's Progress page shows, narrowed to the key, and a service key the guild audience.
 *
 * Each section needs the category the page's panel needs and is left out without it:
 * - `playtime` (`activity` and `stats`): sessions, time online, active time (D-107, D-127), the
 *   active time per day and "where the time goes" per activity;
 * - `xp` (`stats`): XP gained, and per skill the level, XP, gain and the rate over active time;
 * - `loot` (`events`): the value of the drops and how many;
 * - `bosses` (`hiscores`): kill counts, kills gained in the range, rank, loot from the boss (with
 *   `events`);
 * - `wealth` (`inventory`): carried wealth at the end of the range minus the start (D-124);
 * - `goals` (each by its own category, `stats` for levels and XP, `hiscores` for kill counts).
 */
import { DAY_MS, METRICS_RANGES, floorTo, type Category, type MetricsRange } from '@hub/core';
import type { DbOrTx } from '@hub/db';
import { getAccountMetrics, type AccountMetrics } from '../account-metrics';
import { DEFAULT_TIMEZONE } from '../settings/user-settings';
import { apiRestriction, loadApiAccount } from './access';
import { ApiError } from './errors';
import type { ApiPrincipal } from './key-auth';
import { enumParam } from './params';
import type { ApiAccountRef } from './types';
import { principalTimezone } from './xp';

/** The presets of `range`, as on the Progress page; `from`/`to` make a custom one. */
export const PROGRESS_RANGES = METRICS_RANGES.filter(
  (r): r is Exclude<MetricsRange, 'custom'> => r !== 'custom',
);
export type ApiProgressRange = (typeof PROGRESS_RANGES)[number];
export const PROGRESS_DEFAULT_RANGE: ApiProgressRange = '7d';
/** Activities listed under "where the time goes"; the rest are folded into "Other". */
export const PROGRESS_MAX_ACTIVITIES = 8;

const PROGRESS_SECTIONS: readonly Category[] = [
  'activity',
  'stats',
  'events',
  'hiscores',
  'inventory',
];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ApiProgressParams {
  /** A preset ending now; default PROGRESS_DEFAULT_RANGE. Not with `from`/`to`. */
  range?: ApiProgressRange;
  /** A custom range: dates (`YYYY-MM-DD`, in the key creator's time zone, both included) or ISO instants. */
  from?: string;
  to?: string;
}

export interface ApiProgressActivity {
  name: string;
  ms: number;
}

export interface ApiProgress {
  account: ApiAccountRef;
  /** The time zone days are in (`UTC` for a service key). */
  timezone: string;
  /** `today`, `7d`, …, or `custom`. */
  range: MetricsRange;
  from: string;
  to: string;
  /** `activity` and `stats`. */
  playtime?: {
    sessions: number;
    onlineMs: number;
    /** Time in 5-minute blocks with XP, a drop, a step, an inventory or a gear change (D-107, D-127). */
    activeMs: number;
    /** The longest session's time online; null without sessions. */
    longestMs: number | null;
    /** Active time per activity over the range, most first; the tail folded into "Other". */
    activities: ApiProgressActivity[];
    /** Local days with active time, oldest first. */
    days: { date: string; activeMs: number; activities: ApiProgressActivity[] }[];
  };
  /** `stats`. */
  xp?: {
    gained: number;
    /** Every skill (Overall left out), the most gained first. */
    skills: {
      skill: string;
      level: number;
      xp: number;
      gained: number;
      /** Plugin XP per hour of active time spent on it; null without `activity` or such time. */
      xpPerHour: number | null;
    }[];
  };
  /** `events`. */
  loot?: { gp: number; drops: number };
  /** `hiscores`. */
  bosses?: {
    /** Boss kills gained in the range. */
    kills: number;
    /** When the hiscores were last read; null if never. Cut to the UTC day without `activity` (D-50). */
    readAt: string | null;
    /** Bosses on the hiscores, the most kills gained first, then the highest kill count. */
    list: {
      boss: string;
      killCount: number;
      gained: number;
      rank: number | null;
      /** Loot from it in the range; null without `events`. */
      gp: number | null;
    }[];
  };
  /** `inventory`: carried wealth at the end minus the start; null without readings in the range. */
  wealth?: { change: number | null };
  /** The owner's goals the key can read, oldest first. */
  goals: {
    kind: string;
    target: string;
    value: number;
    current: number | null;
    progress: number | null;
    remaining: number | null;
    perDay: number | null;
    etaDays: number | null;
  }[];
}

/** The range asked for, checked. */
export function progressQuery(params: ApiProgressParams): {
  range: MetricsRange;
  from: string | null;
  to: string | null;
} {
  const custom = params.from !== undefined || params.to !== undefined;
  if (custom && params.range !== undefined) {
    throw new ApiError('invalid', 'give either range or from/to, not both');
  }
  if (!custom) {
    return {
      range: enumParam(params.range, 'range', PROGRESS_RANGES, PROGRESS_DEFAULT_RANGE),
      from: null,
      to: null,
    };
  }
  if (params.from === undefined || params.to === undefined) {
    throw new ApiError('invalid', 'from and to go together');
  }
  const at = (value: string, name: string) => {
    const t = DATE_RE.test(value) ? Date.parse(`${value}T00:00:00Z`) : Date.parse(value);
    if (!Number.isFinite(t)) {
      throw new ApiError('invalid', `${name} must be a date (YYYY-MM-DD) or an ISO-8601 date-time`);
    }
    return t;
  };
  if (at(params.from, 'from') > at(params.to, 'to')) {
    throw new ApiError('invalid', 'from must not be after to');
  }
  return { range: 'custom', from: params.from, to: params.to };
}

/**
 * One account's progress over a range (see the file comment); null when the key can't see the
 * account or reads none of its sections, which the route answers 404 (D-70). ApiError 'invalid' for
 * a bad range. A custom range longer than a year keeps its end and is cut to 366 days.
 */
export async function apiProgress(
  db: DbOrTx,
  principal: ApiPrincipal,
  id: string,
  params: ApiProgressParams = {},
  now: Date = new Date(),
): Promise<ApiProgress | null> {
  const q = progressQuery(params);
  const entry = await loadApiAccount(db, principal, id);
  if (!entry || !PROGRESS_SECTIONS.some((c) => entry.access.categories.has(c))) return null;
  const timezone = (await principalTimezone(db, principal)) ?? DEFAULT_TIMEZONE;
  const m = await getAccountMetrics(
    db,
    principal.viewer,
    id,
    {
      range: q.range,
      from: q.from,
      to: q.to,
      session: null,
      compare: false,
      measure: 'active',
      skills: [],
      bosses: [],
      minMinutes: null,
      weekdays: [],
      hours: null,
      activity: null,
    },
    { now, timezone, restrict: apiRestriction(principal) },
  );
  if (!m) return null;
  return toApiProgress(m, timezone);
}

/** The page's model as the API's: only what the key's categories cover (the model's own nulls). */
export function toApiProgress(m: AccountMetrics, timezone: string): ApiProgress {
  const out: ApiProgress = {
    account: { id: m.account.publicId, name: m.account.name },
    timezone,
    range: m.range.preset,
    from: m.range.from,
    to: m.range.to,
    goals: m.goals.map((g) => ({
      kind: g.kind,
      target: g.target,
      value: g.value,
      current: g.current,
      progress: g.progress,
      remaining: g.remaining,
      perDay: g.perDay,
      etaDays: g.etaDays,
    })),
  };
  const sessions = m.totals.sessions;
  if (m.access.sessions && sessions) {
    const t = m.timeByActivity ?? { days: [], series: [] };
    const named = t.series.slice(0, PROGRESS_MAX_ACTIVITIES);
    const rest = t.series.slice(PROGRESS_MAX_ACTIVITIES);
    const fold = (pick: (s: { ms: number[] }) => number): ApiProgressActivity[] => {
      const list = named.map((s) => ({ name: s.name, ms: pick(s) }));
      const other = rest.reduce((sum, s) => sum + pick(s), 0);
      const merged = new Map<string, number>();
      for (const a of other > 0 ? [...list, { name: 'Other', ms: other }] : list) {
        merged.set(a.name, (merged.get(a.name) ?? 0) + a.ms);
      }
      return [...merged.entries()]
        .map(([name, ms]) => ({ name, ms }))
        .filter((a) => a.ms > 0)
        .sort((a, b) => b.ms - a.ms);
    };
    const longest = (m.sessions ?? []).reduce<number | null>(
      (max, s) => (max === null || s.onlineMs > max ? s.onlineMs : max),
      null,
    );
    out.playtime = {
      sessions: sessions.sessions,
      onlineMs: sessions.onlineMs,
      activeMs: sessions.activeMs,
      longestMs: longest,
      activities: fold((s) => s.ms.reduce((a, b) => a + b, 0)),
      days: t.days
        .map((date, i) => {
          const activities = fold((s) => s.ms[i] ?? 0);
          return { date, activeMs: activities.reduce((a, b) => a + b.ms, 0), activities };
        })
        .filter((d) => d.activeMs > 0),
    };
  }
  if (m.skills && m.totals.xp !== null) {
    out.xp = {
      gained: m.totals.xp,
      skills: m.skills
        .filter((s) => s.skill !== 'Overall')
        .map((s) => ({
          skill: s.skill,
          level: s.level,
          xp: s.xp,
          gained: s.gained,
          xpPerHour: s.xpPerHour === null ? null : Math.round(s.xpPerHour),
        }))
        .sort((a, b) => b.gained - a.gained),
    };
  }
  if (m.totals.gp !== null && m.totals.drops !== null) {
    out.loot = { gp: m.totals.gp, drops: m.totals.drops };
  }
  if (m.bosses && m.totals.kills !== null) {
    out.bosses = {
      kills: m.totals.kills,
      readAt: readAt(m.hiscores?.fetchedAt ?? null, m.access.activity),
      list: m.bosses.map((b) => ({
        boss: b.activity,
        killCount: b.score,
        gained: b.gained,
        rank: b.rank,
        gp: b.gp,
      })),
    };
  }
  if (m.access.inventory) out.wealth = { change: m.totals.wealthChange };
  return out;
}

/** A lookup follows the end of a session, so its exact time tells the last-seen time (D-50). */
function readAt(fetchedAt: string | null, activity: boolean): string | null {
  if (fetchedAt === null || activity) return fetchedAt;
  return floorTo(new Date(fetchedAt), DAY_MS).toISOString();
}
