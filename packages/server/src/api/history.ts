/**
 * Histories of one account in the public API (handoff §13): sessions (`activity`), the equipment
 * change log (`equipment`), wealth per day (`inventory`) and the location trail (`location_history`).
 * Each resolves the key's access to the account once (loadApiAccount, D-70), returns null when the
 * key can't read that category on it (the web answers 404), and otherwise reads the rows with the
 * account page's reader (accounts/history.ts read…), so the UI and the API return the same rows.
 */
import type { Category } from '@hub/core';
import type { DbOrTx, SessionEndReason } from '@hub/db';
import {
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

export interface ApiHistoryParams {
  /** Default: `to` − 30 days. */
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
}

/**
 * The location trail in the range (at most one point per minute, kept 30 days), oldest first; when
 * the range holds more than 44,640 points, the newest ones.
 */
export interface ApiLocations extends ApiHistory {
  points: ApiLocationPoint[];
}

/** Several accounts' trails in one call (GET /locations?accounts=a,b, D-92). */
export interface ApiLocationsMulti {
  from: string;
  to: string;
  /** In request order, each with the same points as GET /accounts/{id}/locations. */
  accounts: { account: ApiAccountRef; points: ApiLocationPoint[] }[];
}

function toLocationPoints(rows: readonly LocationPoint[]): ApiLocationPoint[] {
  return rows.map((p) => ({
    at: p.ts,
    x: p.x,
    y: p.y,
    plane: p.plane,
    world: p.world,
    isOnBoat: p.onBoat,
  }));
}

/**
 * Validates the range, resolves the key's access to `category` of the account (the request's one
 * permission check), and reads the rows of the account it resolved.
 */
async function readHistory<T>(
  db: DbOrTx,
  principal: ApiPrincipal,
  id: string,
  params: ApiHistoryParams,
  now: Date,
  category: Category,
  read: (db: DbOrTx, accountId: number, range: HistoryRange) => Promise<T[]>,
): Promise<{ head: ApiHistory; rows: T[] } | null> {
  const range = resolveRange(params, now, HISTORY_DEFAULT_DAYS);
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

/** The location trail (`location_history`); null when the key can't read it. */
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
    readLocationHistory,
  );
  return found && { ...found.head, points: toLocationPoints(found.rows) };
}

/**
 * The location trails of several accounts (GET /locations?accounts=a,b, D-92): at most
 * bulkAccountLimit(principal) accounts, each of which the key must be able to read
 * `location_history` of, else ApiError 'not_found' naming it (D-70). Access is resolved once for all
 * of them. Each trail is exactly what GET /accounts/{id}/locations returns for the same range (same
 * thinning and cap), in request order.
 */
export async function apiLocationsMulti(
  db: DbOrTx,
  principal: ApiPrincipal,
  params: ApiHistoryParams & { ids: string[] },
  now: Date = new Date(),
): Promise<ApiLocationsMulti> {
  const range = resolveRange(params, now, HISTORY_DEFAULT_DAYS);
  const entries = await requireApiAccounts(
    db,
    principal,
    params.ids,
    'location_history',
    'accounts',
    bulkAccountLimit(principal),
  );
  const accounts: ApiLocationsMulti['accounts'] = [];
  for (const entry of entries) {
    const rows = await readLocationHistory(db, entry.account.id, range);
    accounts.push({ account: accountRef(entry), points: toLocationPoints(rows) });
  }
  return { from: range.from.toISOString(), to: range.to.toISOString(), accounts };
}
