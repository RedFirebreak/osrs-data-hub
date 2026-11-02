/**
 * GET /accounts/{id}/day (M8, D-138): one account's day, or a few days, in one call, the REST twin
 * of the MCP tool `day_summary` ("what did Stefan do all day"). A day is a calendar date in the key
 * creator's time zone (their settings; UTC for a service key, as `period=day` on /gains, D-88). Each
 * section comes from the read model of its own endpoint, with that endpoint's category, so a section
 * the key can't read is left out, as on /accounts/{id}:
 * - `sessions` (activity): /accounts/{id}/sessions;
 * - `gains` (stats): /accounts/{id}/gains, the skills that gained;
 * - `events` (events): /events in the range, counted by type, the five most valuable, and the
 *   collection log slots;
 * - `places` (location_history): /accounts/{id}/locations, summarised as stays at named places
 *   (regionName) with the time spent and the visits.
 */
import { localClock, regionId, type Category } from '@hub/core';
import type { DbOrTx } from '@hub/db';
import { startOfLocalDate } from '../account-metrics/range';
import { DEFAULT_TIMEZONE } from '../settings/user-settings';
import { loadApiAccount } from './access';
import { ApiError } from './errors';
import { EVENTS_MAX_LIMIT, apiEventsInRange, type ApiEvent } from './events';
import { apiLocations, apiSessions, type ApiLocationPoint } from './history';
import type { ApiPrincipal } from './key-auth';
import type { ApiAccountRef } from './types';
import { apiGains, principalTimezone } from './xp';

/** Most days one request may cover. */
export const DAY_MAX_DAYS = 7;
/** Most events read for the counts; a busier range says `truncated`. */
export const DAY_MAX_EVENTS = 2_000;
/** How many of the most valuable events are listed. */
export const DAY_TOP_EVENTS = 5;
/** Most places listed; the rest are counted in `stays`. */
export const DAY_MAX_PLACES = 50;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_SECTIONS: readonly Category[] = ['activity', 'stats', 'events', 'location_history'];

export interface ApiDayParams {
  /** One date, `YYYY-MM-DD`. Default: today. Not with `from`/`to`. */
  date?: string;
  /** The first date of a range (with `to`, at most DAY_MAX_DAYS dates). */
  from?: string;
  /** The last date of the range, included. */
  to?: string;
}

export interface ApiPlace {
  /** The place's name (regionName), or `Region <id>` where the map has none. */
  name: string;
  /** The game's map region (64 by 64 tiles) of its first stay. */
  region: number;
  ms: number;
  /** How many separate stays. */
  visits: number;
}

export interface ApiDay {
  account: ApiAccountRef;
  /** The time zone the dates are in (`UTC` for a service key). */
  timezone: string;
  /** The first and last date, `YYYY-MM-DD`. */
  dates: { from: string; to: string };
  /** The instants covered: the first date's start to the end of the last, or now if sooner. */
  from: string;
  to: string;
  /** `activity`. */
  sessions?: {
    count: number;
    totalMs: number;
    list: { startedAt: string; endedAt: string | null; durationMs: number; worlds: number[] }[];
  };
  /** `stats`: Overall's gain, and the skills that gained, most first. */
  gains?: { total: number; skills: { skill: string; xp: number }[] };
  /** `events`. */
  events?: {
    count: number;
    byType: Record<string, number>;
    /** The most valuable, most first. */
    top: ApiEvent[];
    /** New collection log slots, oldest first. */
    collectionLog: ApiEvent[];
    /** More than DAY_MAX_EVENTS events: the counts cover the newest of them. */
    truncated: boolean;
  };
  /** `location_history`. */
  places?: {
    /** Separate stays (a stay ends when the player moves to another place or leaves). */
    stays: number;
    teleports: number;
    /** Most time first. */
    list: ApiPlace[];
    truncated: boolean;
  };
}

/** The dates asked for, checked; `today` is the local date of now. */
export function dayRange(params: ApiDayParams, today: string): { from: string; to: string } {
  if (params.date !== undefined && (params.from !== undefined || params.to !== undefined)) {
    throw new ApiError('invalid', 'give either date or from/to, not both');
  }
  if ((params.from === undefined) !== (params.to === undefined)) {
    throw new ApiError('invalid', 'from and to go together');
  }
  for (const name of ['date', 'from', 'to'] as const) {
    const value = params[name];
    if (value === undefined) continue;
    if (!DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
      throw new ApiError('invalid', `${name} must be a date (YYYY-MM-DD)`);
    }
  }
  const from = params.date ?? params.from ?? today;
  const to = params.date ?? params.to ?? today;
  if (from > to) throw new ApiError('invalid', 'from must not be after to');
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > DAY_MAX_DAYS) throw new ApiError('invalid', `at most ${DAY_MAX_DAYS} days at once`);
  return { from, to };
}

/** The date after `date` (`YYYY-MM-DD`). */
function nextDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * One account's dates (see the file comment); null when the key can see none of the four sections
 * on the account (or not the account), which the route answers 404 like any account (D-70).
 * ApiError 'invalid' for bad dates, a range over DAY_MAX_DAYS, or dates that haven't started yet.
 */
export async function apiDay(
  db: DbOrTx,
  principal: ApiPrincipal,
  id: string,
  params: ApiDayParams = {},
  now: Date = new Date(),
): Promise<ApiDay | null> {
  const timezone = (await principalTimezone(db, principal)) ?? DEFAULT_TIMEZONE;
  const dates = dayRange(params, localClock(now.getTime(), timezone).day);
  const from = startOfLocalDate(dates.from, timezone);
  const end = startOfLocalDate(nextDate(dates.to), timezone);
  if (!from || !end) throw new ApiError('invalid', 'date must be a date (YYYY-MM-DD)');
  if (from.getTime() > now.getTime()) throw new ApiError('invalid', 'that day has not started yet');
  const to = end.getTime() > now.getTime() ? now : new Date(end.getTime() - 1);
  const range = { from, to };

  const readable = new Map<Category, ApiAccountRef>();
  for (const category of DAY_SECTIONS) {
    const entry = await loadApiAccount(db, principal, id, category);
    if (entry) readable.set(category, { id: entry.account.publicId, name: entry.account.name });
  }
  const account = readable.values().next().value;
  if (!account) return null;

  const out: ApiDay = {
    account,
    timezone,
    dates,
    from: from.toISOString(),
    to: to.toISOString(),
  };
  if (readable.has('activity')) {
    const s = await apiSessions(db, principal, id, range, now);
    if (s) {
      // Sessions that overlap the range (the read model's own rule), newest first.
      const list = [...s.sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      out.sessions = {
        count: list.length,
        totalMs: list.reduce((n, x) => n + x.durationMs, 0),
        list: list.map((x) => ({
          startedAt: x.startedAt,
          endedAt: x.endedAt,
          durationMs: x.durationMs,
          worlds: x.worlds,
        })),
      };
    }
  }
  if (readable.has('stats')) {
    // A range that runs to now reads the current XP, as `period=day` does: the XP at an instant
    // comes from the stored samples, which can be a few seconds behind the last snapshot.
    const g = await apiGains(db, principal, id, to === now ? { from } : range, now);
    if (g) {
      const overall = g.gains.find((x) => x.skill === 'Overall')?.xp ?? 0;
      out.gains = {
        total: overall,
        skills: g.gains
          .filter((x) => x.skill !== 'Overall' && x.xp > 0)
          .sort((a, b) => b.xp - a.xp),
      };
    }
  }
  if (readable.has('events')) out.events = await dayEvents(db, principal, id, range, now);
  if (readable.has('location_history')) {
    const l = await apiLocations(db, principal, id, range, now);
    if (l) {
      const stays = placeStays(l.points);
      const list = placesOf(stays);
      out.places = {
        stays: stays.length,
        teleports: stays.filter((s) => s.arrivedBy === 'teleport').length,
        list: list.slice(0, DAY_MAX_PLACES),
        truncated: l.truncated || list.length > DAY_MAX_PLACES,
      };
    }
  }
  return out;
}

async function dayEvents(
  db: DbOrTx,
  principal: ApiPrincipal,
  id: string,
  range: { from: Date; to: Date },
  now: Date,
): Promise<NonNullable<ApiDay['events']>> {
  const all: ApiEvent[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (;;) {
    const page = await apiEventsInRange(
      db,
      principal,
      { ...range, accountIds: [id], limit: EVENTS_MAX_LIMIT, ...(cursor ? { cursor } : {}) },
      now,
    );
    all.push(...page.events);
    if (page.nextCursor === null) break;
    if (all.length >= DAY_MAX_EVENTS) {
      truncated = true;
      break;
    }
    cursor = page.nextCursor;
  }
  const byType: Record<string, number> = {};
  for (const e of all) byType[e.type] = (byType[e.type] ?? 0) + 1;
  const top = all
    .filter((e) => (e.valueGp ?? 0) > 0)
    .sort((a, b) => (b.valueGp ?? 0) - (a.valueGp ?? 0))
    .slice(0, DAY_TOP_EVENTS);
  const collectionLog = all
    .filter((e) => e.type === 'collection_log')
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  return { count: all.length, byType, top, collectionLog, truncated };
}

/** A stretch of a trail at one place. */
export interface PlaceStay {
  /** The place's name, or `Region <id>` where the map has none. */
  name: string;
  region: number;
  plane: number;
  from: string;
  to: string;
  ms: number;
  /** How the player got there from the stay before (move, teleport, entrance, …); null if unknown. */
  arrivedBy: string | null;
}

/**
 * A trail (oldest first) as stays: consecutive points at one place (its name, else its numeric
 * region), how the player got there, and how long they were there. A stay ends at its last point
 * when the next step is a gap (the player was away), otherwise when the next stay starts.
 */
export function placeStays(
  points: readonly Pick<ApiLocationPoint, 'at' | 'x' | 'y' | 'plane' | 'via' | 'region'>[],
): PlaceStay[] {
  const out: PlaceStay[] = [];
  for (const p of points) {
    const region = regionId({ x: p.x, y: p.y });
    const name = p.region ?? `Region ${region}`;
    const last = out.at(-1);
    if (last && last.name === name && p.via !== 'gap') {
      last.to = p.at;
      continue;
    }
    if (last && p.via !== 'gap') last.to = p.at;
    out.push({ name, region, plane: p.plane, from: p.at, to: p.at, ms: 0, arrivedBy: p.via });
  }
  for (const s of out) s.ms = Date.parse(s.to) - Date.parse(s.from);
  return out;
}

/** Stays added up per place, most time first (then most visits, then by name). */
export function placesOf(stays: readonly PlaceStay[]): ApiPlace[] {
  const byName = new Map<string, ApiPlace>();
  for (const s of stays) {
    const p = byName.get(s.name) ?? { name: s.name, region: s.region, ms: 0, visits: 0 };
    p.ms += s.ms;
    p.visits += 1;
    byName.set(s.name, p);
  }
  return [...byName.values()].sort(
    (a, b) => b.ms - a.ms || b.visits - a.visits || a.name.localeCompare(b.name),
  );
}
