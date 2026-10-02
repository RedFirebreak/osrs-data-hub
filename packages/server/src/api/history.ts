/**
 * Histories of one account in the public API (handoff §13): sessions (`activity`), the equipment
 * change log (`equipment`), wealth per day (`inventory`) and the location trail (`location_history`).
 * Each resolves the key's access to the account once (loadApiAccount, D-70), returns null when the
 * key can't read that category on it (the web answers 404), and otherwise reads the rows with the
 * account page's reader (accounts/history.ts read…), so the UI and the API return the same rows.
 *
 * The location trail has its own default range and limits (D-102): it holds a point per tile, not
 * a row per day or per change.
 */
import type { Category, TrailStep } from '@hub/core';
import type { DbOrTx, SessionEndReason } from '@hub/db';
import { DAY_MS } from '@hub/core';
import {
  MAX_LOCATION_POINTS,
  readEquipmentHistory,
  readLocationHistory,
  readSessions,
  readWealthHistory,
  type HistoryRange,
  type LocationPoint,
} from '../accounts/history';
import { accountRef, bulkAccountLimit, loadApiAccount, requireApiAccounts } from './access';
import type { ApiPrincipal } from './key-auth';
import { resolveRange } from './params';
import { toApiItems, type ApiAccountRef, type ApiItem } from './types';

/** The range of a history request without `from`: the last 30 days. */
export const HISTORY_DEFAULT_DAYS = 30;
/** … and of a location trail request: the last 24 hours (D-102). */
export const LOCATIONS_DEFAULT_HOURS = 24;
/** Most points one `/locations` response holds, shared equally between its accounts (D-102). */
export const MAX_LOCATION_POINTS_PER_RESPONSE = 100_000;

/**
 * Most points per account when one response holds the trails of `accounts` accounts: the
 * per-account limit, lowered so the response stays within MAX_LOCATION_POINTS_PER_RESPONSE.
 */
export function locationPointLimit(accounts: number): number {
  return Math.min(
    MAX_LOCATION_POINTS,
    Math.floor(MAX_LOCATION_POINTS_PER_RESPONSE / Math.max(1, accounts)),
  );
}

export interface ApiHistoryParams {
  /** Default: `to` − 30 days (the location trail: `to` − 24 hours). */
  from?: Date;
  /** Default: now. */
  to?: Date;
}

interface ApiHistory {
  account: ApiAccountRef;
  from: string;
  to: string;
}

export interface ApiSession {
  id: string;
  startedAt: string;
  /** null while the session is still open. */
  endedAt: string | null;
  /** The last in-game payload of the session. */
  lastSeenAt: string;
  /** (endedAt ?? lastSeenAt) − startedAt. */
  durationMs: number;
  /** Worlds played on, special worlds included (D-45). */
  worlds: number[];
  /** logout, shutdown, disabled (the plugin was turned off), timeout; null while open. */
  endReason: SessionEndReason | null;
}

/** Play sessions overlapping the range, newest first (at most 1000). */
export interface ApiSessions extends ApiHistory {
  sessions: ApiSession[];
}

export interface ApiEquipmentChange {
  changedAt: string;
  /** The whole worn set after the change. */
  items: ApiItem[];
}

/** Equipment changes in the range, newest first (at most 500). */
export interface ApiEquipmentHistory extends ApiHistory {
  changes: ApiEquipmentChange[];
}

export interface ApiWealthDay {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  /** Carried value (inventory + equipment, GE prices) at the day's last update. */
  lastValue: number;
  /** The day's highest carried value. */
  maxValue: number;
}

/** Carried wealth per UTC day in the range, oldest first. */
export interface ApiWealth extends ApiHistory {
  days: ApiWealthDay[];
}

export interface ApiLocationPoint {
  at: string;
  x: number;
  y: number;
  plane: number;
  world: number | null;
  isOnBoat: boolean;
  /** How the player got here from the point before; null when that point isn't known (D-103). */
  via: TrailStep | null;
}

interface ApiTrail {
  /** Oldest first. */
  points: ApiLocationPoint[];
  /**
   * The range holds more points than the response may carry for this account, and these are the
   * newest. Ask again with `to` set to the first point's `at` for the ones before.
   */
  truncated: boolean;
}

/**
 * The location trail in the range (kept 30 days): every tile a 1.6 plugin reported, one point a
 * minute from older plugins. At most 20,000 points, the newest (D-102). Each point says how the
 * player got there (D-103).
 */
export interface ApiLocations extends ApiHistory, ApiTrail {}

/** Several accounts' trails in one call (GET /locations?accounts=a,b, D-92). */
export interface ApiLocationsMulti {
  from: string;
  to: string;
  /**
   * In request order. Each is what GET /accounts/{id}/locations returns for the same range, with a
   * lower limit per account when the request names more than 5 (locationPointLimit).
   */
  accounts: ({ account: ApiAccountRef } & ApiTrail)[];
}

function toLocationPoints(rows: readonly LocationPoint[]): ApiLocationPoint[] {
  return rows.map((p) => ({
    at: p.ts,
    x: p.x,
    y: p.y,
    plane: p.plane,
    world: p.world,
    isOnBoat: p.onBoat,
    via: p.via,
  }));
}

/**
 * Validates the range, resolves the key's access to `category` of the account (the request's one
 * permission check), and reads the rows of the account it resolved.
 */
async function readHistory<R>(
  db: DbOrTx,
  principal: ApiPrincipal,
  id: string,
  params: ApiHistoryParams,
  now: Date,
  category: Category,
  read: (db: DbOrTx, accountId: number, range: HistoryRange) => Promise<R>,
  defaultDays: number = HISTORY_DEFAULT_DAYS,
): Promise<{ head: ApiHistory; rows: R } | null> {
  const range = resolveRange(params, now, defaultDays);
  const entry = await loadApiAccount(db, principal, id, category);
  if (!entry) return null;
  const rows = await read(db, entry.account.id, range);
  const head = {
    account: accountRef(entry),
    from: range.from.toISOString(),
    to: range.to.toISOString(),
  };
  return { head, rows };
}

/** Play sessions (`activity`); null when the key can't read them. ApiError 'invalid' for a bad range. */
export async function apiSessions(
  db: DbOrTx,
  principal: ApiPrincipal,
  id: string,
  params: ApiHistoryParams = {},
  now: Date = new Date(),
): Promise<ApiSessions | null> {
  const found = await readHistory(db, principal, id, params, now, 'activity', readSessions);
  return (
    found && {
      ...found.head,
      sessions: found.rows.map((s) => ({
        id: s.id,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        lastSeenAt: s.lastSeenAt,
        durationMs: s.durationMs,
        worlds: s.worlds,
        endReason: s.endReason,
      })),
    }
  );
}

/** The equipment change log (`equipment`); null when the key can't read it. */
export async function apiEquipmentHistory(
  db: DbOrTx,
  principal: ApiPrincipal,
  id: string,
  params: ApiHistoryParams = {},
  now: Date = new Date(),
): Promise<ApiEquipmentHistory | null> {
  const found = await readHistory(
    db,
    principal,
    id,
    params,
    now,
    'equipment',
    readEquipmentHistory,
  );
  return (
    found && {
      ...found.head,
      changes: found.rows.map((c) => ({ changedAt: c.changedAt, items: toApiItems(c.items) })),
    }
  );
}

/** Carried wealth per day (`inventory`); null when the key can't read it. */
export async function apiWealth(
  db: DbOrTx,
  principal: ApiPrincipal,
  id: string,
  params: ApiHistoryParams = {},
  now: Date = new Date(),
): Promise<ApiWealth | null> {
  const found = await readHistory(db, principal, id, params, now, 'inventory', readWealthHistory);
  return (
    found && {
      ...found.head,
      days: found.rows.map((d) => ({ day: d.day, lastValue: d.lastValue, maxValue: d.maxValue })),
    }
  );
}

const LOCATIONS_DEFAULT_DAYS = (LOCATIONS_DEFAULT_HOURS * 60 * 60 * 1000) / DAY_MS;

/**
 * The location trail (`location_history`); null when the key can't read it. Default range: the
 * last 24 hours. At most MAX_LOCATION_POINTS points, the newest, with `truncated` (D-102).
 */
export async function apiLocations(
  db: DbOrTx,
  principal: ApiPrincipal,
  id: string,
  params: ApiHistoryParams = {},
  now: Date = new Date(),
): Promise<ApiLocations | null> {
  const found = await readHistory(
    db,
    principal,
    id,
    params,
    now,
    'location_history',
    (tx, accountId, range) => readLocationHistory(tx, accountId, range),
    LOCATIONS_DEFAULT_DAYS,
  );
  return (
    found && {
      ...found.head,
      points: toLocationPoints(found.rows.points),
      truncated: found.rows.truncated,
    }
  );
}

/**
 * The location trails of several accounts (GET /locations?accounts=a,b, D-92): at most
 * bulkAccountLimit(principal) accounts, each of which the key must be able to read
 * `location_history` of, else ApiError 'not_found' naming it (D-70). Access is resolved once for all
 * of them. Each trail is what GET /accounts/{id}/locations returns for the same range, in request
 * order, except that the points one response may hold are shared between its accounts
 * (locationPointLimit, D-102): with more than 5 accounts a long trail is cut sooner, and says so.
 */
export async function apiLocationsMulti(
  db: DbOrTx,
  principal: ApiPrincipal,
  params: ApiHistoryParams & { ids: string[] },
  now: Date = new Date(),
): Promise<ApiLocationsMulti> {
  const range = resolveRange(params, now, LOCATIONS_DEFAULT_DAYS);
  const entries = await requireApiAccounts(
    db,
    principal,
    params.ids,
    'location_history',
    'accounts',
    bulkAccountLimit(principal),
  );
  const limit = locationPointLimit(entries.length);
  const accounts: ApiLocationsMulti['accounts'] = [];
  for (const entry of entries) {
    const trail = await readLocationHistory(db, entry.account.id, range, limit);
    accounts.push({
      account: accountRef(entry),
      points: toLocationPoints(trail.points),
      truncated: trail.truncated,
    });
  }
  return { from: range.from.toISOString(), to: range.to.toISOString(), accounts };
}
