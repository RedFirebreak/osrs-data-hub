/**
 * Catch-up reads for the live stream (handoff §11): the `Last-Event-ID` replay when an EventSource
 * reconnects, and the polling fallback `GET /api/live/events?after=<seq>`.
 */
import { resolveAccess, type ResolvedAccess, type ToastFilter, type Viewer } from '@hub/core';
import { events, osrsAccounts, type DbOrTx } from '@hub/db';
import { and, asc, eq, gt, inArray, lt, lte, max, sql, type SQL } from 'drizzle-orm';
import { loadAccountAccess } from '../accounts/access';
import { toFeedEvent } from '../feed';
import { EVENT_ROW_COLUMNS } from './load';
import { toEventMessage, type LiveEventMessage } from './messages';

/** How far back a reconnect or a poll reaches (handoff §11: "replays the last 5 minutes"). */
export const LIVE_REPLAY_MAX_AGE_MS = 5 * 60 * 1000;
export const REPLAY_DEFAULT_LIMIT = 200;
const REPLAY_MAX_LIMIT = 1000;
/**
 * The `settleMs` the polling fallback should pass (DB-4). Ingest inserts events last and commits right
 * after, within its 3 s lock and 8 s statement timeouts, so after 10 s no lower seq is still pending.
 */
export const LIVE_POLL_SETTLE_MS = 10_000;
/**
 * received_at is the request's receive time and seq is taken at insert, seconds later at most (ingest's
 * lock and statement timeouts), so a row received after T has a higher seq than every row received
 * a minute before T. That bounds the scan (seqFloor).
 */
const RECEIVE_ORDER_SLACK_MS = 60_000;

export interface ReplayOptions {
  /** Only events with seq > afterSeq (the client's Last-Event-ID or `after`). */
  afterSeq: number;
  /** Only events received within this window before `now`. */
  maxAgeMs: number;
  /** Default 200, clamped to 1…1000. */
  limit?: number;
  now: Date;
  toast: ToastFilter;
  /**
   * Serve only seqs below the first one inserted less than this long ago (database clock), default 0.
   * A cursor client must not move past a seq that may still commit: seq is taken at INSERT, so a lower
   * seq can become visible after a higher one (DB-4). The polling fallback passes LIVE_POLL_SETTLE_MS. The SSE
   * replay passes 0: it runs after the stream subscribed, so anything held back that had already
   * committed would never be delivered.
   */
  settleMs?: number;
}

/**
 * The viewer's events with seq > afterSeq, received in the last `maxAgeMs`, ascending by seq, at
 * most `limit`: only accounts whose `events` the viewer may read (resolveAccess), each event redacted
 * for them (toFeedEvent) and flagged with their toast filter (so events older than 15 minutes don't
 * toast). Accounts are filtered in SQL before the limit, so a burst from accounts the viewer can't see
 * never hides later events that they can. Clients dedupe by event id: a stream that subscribes and then
 * replays can receive an event both ways.
 *
 * Two reads: the accounts with events in the window (and each one's highest seq), then the rows of
 * the readable ones. The second never returns a seq above the highest the first saw for them: rows
 * that commit or settle between the reads may belong to an account the first read didn't see, and a
 * later row of a known account would move the client's cursor past them for good (DB-4).
 */
export async function replayEvents(
  db: DbOrTx,
  viewer: Viewer,
  opts: ReplayOptions,
): Promise<LiveEventMessage[]> {
  if (viewer.status !== 'active') return [];
  const window = replayWindow(opts);
  if (!window) return [];

  const candidates = await db
    .select({ accountId: events.accountId, maxSeq: max(events.seq) })
    .from(events)
    .where(window)
    .groupBy(events.accountId);
  const allowed = await readableAccounts(db, viewer, candidates);
  if (allowed.size === 0) return [];
  const highestSeen = Math.max(...[...allowed.values()].map((a) => a.maxSeq));

  const rows = await db
    .select({
      ...EVENT_ROW_COLUMNS,
      publicId: osrsAccounts.publicId,
      accountName: osrsAccounts.currentName,
    })
    .from(events)
    .innerJoin(osrsAccounts, eq(osrsAccounts.id, events.accountId))
    .where(
      and(window, inArray(events.accountId, [...allowed.keys()]), lte(events.seq, highestSeen)),
    )
    .orderBy(asc(events.seq))
    .limit(clampLimit(opts.limit));

  return rows.flatMap((row) => {
    const access = allowed.get(row.accountId);
    if (!access) return [];
    const event = toFeedEvent(
      row,
      { publicId: row.publicId, name: row.accountName },
      access.resolved.categories,
    );
    return [toEventMessage(event, opts.toast, access.resolved, opts.now)];
  });
}

/**
 * Where a poller without a cursor starts (`GET /api/live/events` without `after`): the highest seq it
 * may start after, 0 for an empty table. That is the newest seq below the first row inserted less
 * than LIVE_POLL_SETTLE_MS ago (database clock), so no lower seq can still commit after it (DB-4,
 * as settledCeiling). `floor`, the newest seq received more than two minutes ago, is settled by far
 * (ingest's lock and statement timeouts are seconds) and bounds both scans to the seq index range of
 * the last two minutes (received_at and inserted_at have no index).
 */
export async function settledLiveCursor(
  db: DbOrTx,
  settleMs: number = LIVE_POLL_SETTLE_MS,
): Promise<number> {
  const result = await db.execute<{ cursor: number | string }>(sql`
    WITH f AS (
      SELECT coalesce((
        SELECT ${events.seq} FROM ${events}
        WHERE ${events.receivedAt} <= now() - interval '2 minutes'
        ORDER BY ${events.seq} DESC LIMIT 1
      ), 0) AS floor
    )
    SELECT greatest(f.floor, coalesce((
      SELECT max(e.seq) FROM ${events} e
      WHERE e.seq > f.floor
        AND e.seq < coalesce((
          SELECT min(y.seq) FROM ${events} y
          WHERE y.seq > f.floor
            AND y.inserted_at > clock_timestamp() - make_interval(secs => ${settleMs / 1000})
        ), ${Number.MAX_SAFE_INTEGER})
    ), 0)) AS cursor
    FROM f`);
  return Number(result.rows[0]?.cursor ?? 0);
}

/** The WHERE clause shared by both queries; null when the options can't match anything. */
function replayWindow(opts: ReplayOptions): SQL | null {
  const nowMs = opts.now.getTime();
  if (!Number.isFinite(nowMs) || !Number.isFinite(opts.maxAgeMs) || opts.maxAgeMs <= 0) return null;
  // A cursor that isn't a safe integer (NaN, 1e300) can't be compared exactly; start from 0 then.
  const afterSeq = Number.isSafeInteger(opts.afterSeq) ? Math.max(opts.afterSeq, 0) : 0;
  const cutoff = new Date(nowMs - opts.maxAgeMs);
  const floor = seqFloor(new Date(cutoff.getTime() - RECEIVE_ORDER_SLACK_MS));
  const parts: SQL[] = [
    gt(events.seq, afterSeq),
    gt(events.seq, floor),
    gt(events.receivedAt, cutoff),
  ];
  const settleMs = opts.settleMs ?? 0;
  if (Number.isFinite(settleMs) && settleMs > 0) {
    parts.push(lt(events.seq, settledCeiling(afterSeq, floor, settleMs)));
  }
  return and(...parts) ?? null;
}

/**
 * The highest seq received at or before `before` (0 when none), so the window is an index range on
 * seq even when the client's cursor is 0 or far behind: `received_at` has no index, and without this
 * bound every poll would scan the whole events table. Found by walking the seq index backwards from
 * the newest row, which reads only the rows of the last few minutes. Evaluated once per query
 * (an InitPlan). Also bounds the public API's cursor feed (api/events.ts).
 */
export function seqFloor(before: Date): SQL {
  return sql`coalesce((select ${events.seq} from ${events} where ${events.receivedAt} <= ${before} order by ${events.seq} desc limit 1), 0)`;
}

/**
 * The lowest seq above the cursor inserted less than `settleMs` ago (database clock: inserted_at is
 * clock_timestamp() at insert), or "no limit". Serving only seqs BELOW it, rather than skipping each
 * young row on its own, keeps the result a gap-free prefix: inserted_at order can differ from seq
 * order (a backend descheduled between taking its seq and its timestamp, or the database clock
 * stepping back), and a settled row above a young one would move the cursor past it (DB-4). The
 * walk up the seq index starts at the window's floor, so it reads only the last few minutes. `floor`
 * must be at or below every seq that can still be young (seqFloor of a time well before the margin).
 * Also used by the public API's cursor feed (api/events.ts).
 */
export function settledCeiling(afterSeq: number, floor: SQL, settleMs: number): SQL {
  return sql`coalesce((select min(${events.seq}) from ${events} where ${events.seq} > ${afterSeq} and ${events.seq} > ${floor} and ${events.insertedAt} > clock_timestamp() - make_interval(secs => ${settleMs / 1000})), ${Number.MAX_SAFE_INTEGER})`;
}

interface ReadableAccount {
  resolved: ResolvedAccess;
  /** The highest seq of this account the candidate read saw. */
  maxSeq: number;
}

/** The candidate accounts whose `events` category the viewer may read. */
async function readableAccounts(
  db: DbOrTx,
  viewer: Viewer,
  candidates: readonly { accountId: number; maxSeq: number | null }[],
): Promise<Map<number, ReadableAccount>> {
  const accessMap = await loadAccountAccess(
    db,
    candidates.map((c) => c.accountId),
  );
  const allowed = new Map<number, ReadableAccount>();
  for (const { accountId, maxSeq } of candidates) {
    const access = accessMap.get(accountId);
    if (!access || maxSeq === null) continue;
    const resolved = resolveAccess(viewer, access);
    if (resolved.categories.has('events')) allowed.set(accountId, { resolved, maxSeq });
  }
  return allowed;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return REPLAY_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), REPLAY_MAX_LIMIT);
}
