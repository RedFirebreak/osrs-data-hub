/**
 * GET /events of the public API (handoff §13, D-73): a cursor feed of events ordered by `seq`, for
 * the Discord bot and Home Assistant automations.
 *
 * `seq` is taken at INSERT, not at commit, so a lower seq can become visible after a higher one
 * (DB-4). The feed therefore serves only the SETTLED prefix: seqs below the first row inserted less
 * than API_EVENTS_SETTLE_MS ago, using the live replay's settledCeiling. A cursor never passes a row
 * that may still commit, as long as ingest's event-inserting transactions commit within that margin
 * (they insert events last and commit right after).
 */
import type { DbOrTx } from '@hub/db';
import { events } from '@hub/db';
import { and, asc, desc, gt, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { AccountWithAccess } from '../accounts/load';
import { toFeedEvent, type FeedEvent } from '../feed';
import { EVENT_ROW_COLUMNS } from '../live/load';
import { LIVE_POLL_SETTLE_MS, seqFloor, settledCeiling } from '../live/replay';
import { loadApiAccounts, requireApiAccounts } from './access';
import { ApiError } from './errors';
import type { ApiPrincipal } from './keys';
import { intParam, listParam } from './params';
import type { ApiAccountRef } from './types';

/**
 * Rows inserted less than this long ago (database clock) end the settled prefix (D-73). The live
 * replay's margin, not the handoff's "~2 s": a commit delayed past the margin (an I/O stall) would be
 * skipped by a cursor for good, while 8 s more latency costs a bot or an automation nothing.
 */
export const API_EVENTS_SETTLE_MS = LIVE_POLL_SETTLE_MS;
export const EVENTS_DEFAULT_LIMIT = 100;
export const EVENTS_MAX_LIMIT = 500;
/** Longest accepted `types` list, and longest type name. */
const MAX_TYPES = 64;
const MAX_TYPE_LENGTH = 64;
/**
 * Rows received longer ago than this are settled by far (ingest's lock and statement timeouts are
 * seconds), so the newest of them bounds the settled-ceiling scan to the last few minutes (seqFloor).
 */
const FLOOR_AGE_MS = 2 * 60 * 1000;
const CURSOR_VERSION = 'v1';
const CURSOR_RE = /^v1:(0|[1-9][0-9]{0,15})$/;

/** An event as the API returns it: the feed's event without the internal cursor and UI hints. */
export interface ApiEvent {
  /** Public event id (uuid v7). */
  id: string;
  /** Stored type: loot, pk_loot, death, level_up, collection_log, superior_spawn,
   *  achievement_diary, combat_task, or an unknown plugin type as sent. */
  type: string;
  account: ApiAccountRef;
  /** When it happened: the plugin's time, clamped to [received − 15 min, received] (D-17). */
  occurredAt: string;
  /** When the hub received it. */
  receivedAt: string;
  /** Loot value in GP where the type has one. */
  valueGp: number | null;
  itemId: number | null;
  npcId: number | null;
  skill: string | null;
  level: number | null;
  tier: string | null;
  points: number | null;
  /** Happened on a special world (league, deadman, …). */
  specialWorld: boolean;
  /**
   * The event as the plugin sent it ({type, data, eventId, timestamp}); its shape depends on `type`.
   * `data.location` (deaths, superior spawns) is removed unless the key reads `location_live` or
   * `location_history` on the account (handoff §10).
   */
  data: unknown;
  /** Short title, e.g. "Loot". */
  title: string;
  /** One line, e.g. "Zezima received Dragon warhammer (38.2M) from Lizardman shaman". */
  line: string;
}

export interface ApiEventsParams {
  /**
   * Omitted: the newest `limit` settled events and a cursor after them. 'now': no events, only the
   * current cursor (start following from here). Otherwise a `nextCursor` from an earlier response:
   * the settled events after it, oldest first.
   */
  cursor?: string;
  /** Only these stored types; empty = every type. */
  types?: string[];
  /** Only these accounts (public ids); each must be one whose events the key may read. */
  accountIds?: string[];
  /** Only events with value_gp ≥ this (events without a value are left out). */
  minValue?: number;
  /** Default 100, at most 500. */
  limit?: number;
}

export interface ApiEventsPage {
  /** Ascending by seq (the order they were stored). */
  events: ApiEvent[];
  /**
   * Pass as `cursor` next time. Always returned; unchanged when nothing new has settled. Fewer than
   * `limit` events means "caught up for now", not "no more ever".
   */
  nextCursor: string;
}

/** The opaque cursor for "after seq": base64url("v1:<seq>"). */
export function encodeEventsCursor(seq: number): string {
  return Buffer.from(`${CURSOR_VERSION}:${seq}`, 'utf8').toString('base64url');
}

/** The seq inside a cursor from encodeEventsCursor; null for anything else. */
export function decodeEventsCursor(cursor: string): number | null {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 64) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  const match = CURSOR_RE.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  const seq = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(seq)) return null;
  // Only the canonical spelling: base64url decoding ignores stray bits and padding.
  return encodeEventsCursor(seq) === cursor ? seq : null;
}

/**
 * A page of the cursor feed (D-73): events of the accounts whose `events` category the key may read
 * (D-70), redacted for the key's categories on each account, ordered by seq, from the settled prefix
 * only (see the module comment). Filters: `types`, `accountIds` (ApiError 'not_found' for an account
 * the key can't read events of, like an unknown one), `minValue` (on value_gp). The cursor advances
 * past settled rows the filters leave out, so they aren't scanned again. ApiError 'invalid' for a
 * malformed cursor, limit, minValue or list.
 */
export async function apiEvents(
  db: DbOrTx,
  principal: ApiPrincipal,
  params: ApiEventsParams = {},
  now: Date = new Date(),
): Promise<ApiEventsPage> {
  const limit = intParam(params.limit, 'limit', {
    min: 1,
    max: EVENTS_MAX_LIMIT,
    fallback: EVENTS_DEFAULT_LIMIT,
  });
  const minValue =
    params.minValue === undefined
      ? null
      : intParam(params.minValue, 'min_value', {
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
          fallback: 0,
        });
  const types = listParam(params.types, 'types', MAX_TYPES) ?? [];
  if (types.some((t) => t.length === 0 || t.length > MAX_TYPE_LENGTH || t.includes('\u0000'))) {
    throw new ApiError('invalid', 'types must be event type names');
  }
  const after = parseCursor(params.cursor);
  if (params.cursor === 'now') {
    return { events: [], nextCursor: encodeEventsCursor(await settledSeqAfter(db, 0, now)) };
  }

  const accounts = await readableAccounts(db, principal, params.accountIds);
  const settled = await settledSeqAfter(db, after ?? 0, now);
  if (accounts.size === 0) return { events: [], nextCursor: encodeEventsCursor(settled) };

  const filter = and(
    inArray(events.accountId, [...accounts.keys()]),
    lte(events.seq, settled),
    after === null ? undefined : gt(events.seq, after),
    types.length > 0 ? inArray(events.type, types) : undefined,
    minValue === null ? undefined : gte(events.valueGp, minValue),
  );
  const rows = await db
    .select(EVENT_ROW_COLUMNS)
    .from(events)
    .where(filter)
    .orderBy(after === null ? desc(events.seq) : asc(events.seq))
    .limit(limit);
  if (after === null) rows.reverse(); // the newest `limit`, oldest first

  const last = rows.at(-1);
  // A full page may have more after it; otherwise every settled row up to `settled` was considered.
  const next = after !== null && rows.length === limit && last ? last.seq : settled;
  return {
    events: rows.flatMap((row) => {
      const entry = accounts.get(row.accountId);
      return entry ? [toApiEvent(toFeedEvent(row, feedRef(entry), entry.access.categories))] : [];
    }),
    nextCursor: encodeEventsCursor(next),
  };
}

function parseCursor(cursor: string | undefined): number | null {
  if (cursor === undefined || cursor === 'now') return null;
  const seq = decodeEventsCursor(cursor);
  if (seq === null) throw new ApiError('invalid', 'cursor is not a cursor from this feed');
  return seq;
}

/** The accounts whose events the key may read, by internal id (only `accountIds` when given). */
async function readableAccounts(
  db: DbOrTx,
  principal: ApiPrincipal,
  accountIds: readonly string[] | undefined,
): Promise<Map<number, AccountWithAccess>> {
  const entries =
    accountIds !== undefined && accountIds.length > 0
      ? await requireApiAccounts(db, principal, accountIds, 'events', 'accounts')
      : (await loadApiAccounts(db, principal)).filter((e) => e.access.categories.has('events'));
  return new Map(entries.map((e) => [e.account.id, e]));
}

/**
 * The highest seq above `afterSeq` in the settled prefix (below settledCeiling), or `afterSeq` when
 * there is none. One statement, so the ceiling and the maximum see the same rows. The ceiling scan
 * starts at seqFloor (the newest row received more than FLOOR_AGE_MS before `now`) and the maximum is
 * one probe of the seq index, so this reads only the last few minutes' rows whatever the cursor.
 */
async function settledSeqAfter(db: DbOrTx, afterSeq: number, now: Date): Promise<number> {
  const floor = seqFloor(new Date(now.getTime() - FLOOR_AGE_MS));
  const ceiling: SQL = settledCeiling(afterSeq, floor, API_EVENTS_SETTLE_MS);
  const result = await db.execute<{ settled: number | string | null }>(sql`
    SELECT max(${events.seq}) AS settled FROM ${events}
    WHERE ${events.seq} > ${afterSeq} AND ${events.seq} < ${ceiling}`);
  const settled = result.rows[0]?.settled;
  return settled === null || settled === undefined ? afterSeq : Number(settled);
}

function feedRef(entry: AccountWithAccess): { publicId: string; name: string } {
  return { publicId: entry.account.publicId, name: entry.account.name };
}

/** The feed's event → the API's: `seq` stays internal (the cursor is opaque), `icon` is a UI hint. */
function toApiEvent(event: FeedEvent): ApiEvent {
  return {
    id: event.id,
    type: event.type,
    account: { id: event.account.publicId, name: event.account.name },
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    valueGp: event.valueGp,
    itemId: event.itemId,
    npcId: event.npcId,
    skill: event.skill,
    level: event.level,
    tier: event.tier,
    points: event.points,
    specialWorld: event.specialWorld,
    data: event.data,
    title: event.title,
    line: event.line,
  };
}
