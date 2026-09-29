/**
 * Catch-up reads for the live stream (handoff §11): the `Last-Event-ID` replay when an EventSource
 * reconnects, and the polling fallback `GET /api/live/events?after=<seq>`.
 */
import { resolveAccess, type ResolvedAccess, type ToastFilter, type Viewer } from '@hub/core';
import { events, osrsAccounts, type DbOrTx } from '@hub/db';
import { and, asc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import { loadAccountAccess } from '../accounts/access';
import { toFeedEvent } from '../feed';
import { EVENT_ROW_COLUMNS } from './load';
import { toEventMessage, type LiveEventMessage } from './messages';

/** How far back a reconnect or a poll reaches (handoff §11: "replays the last 5 minutes"). */
export const LIVE_REPLAY_MAX_AGE_MS = 5 * 60 * 1000;
export const REPLAY_DEFAULT_LIMIT = 200;
export const REPLAY_MAX_LIMIT = 1000;
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
   * Serve only rows inserted at least this long ago (database clock), default 0. A cursor client must
   * not move past a seq that may still commit: seq is taken at INSERT, so a lower seq can become
   * visible after a higher one (DB-4). The polling fallback passes LIVE_POLL_SETTLE_MS. The SSE
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
 */
export async function replayEvents(
  db: DbOrTx,
  viewer: Viewer,
  opts: ReplayOptions,
): Promise<LiveEventMessage[]> {
  if (viewer.status !== 'active') return [];
  const window = replayWindow(opts);
  if (!window) return [];

  const allowed = await readableAccounts(db, viewer, window);
  if (allowed.size === 0) return [];

  const rows = await db
    .select({
      ...EVENT_ROW_COLUMNS,
      publicId: osrsAccounts.publicId,
      accountName: osrsAccounts.currentName,
    })
    .from(events)
    .innerJoin(osrsAccounts, eq(osrsAccounts.id, events.accountId))
    .where(and(window, inArray(events.accountId, [...allowed.keys()])))
    .orderBy(asc(events.seq))
    .limit(clampLimit(opts.limit));

  return rows.flatMap((row) => {
    const access = allowed.get(row.accountId);
    if (!access) return [];
    const event = toFeedEvent(
      row,
      { publicId: row.publicId, name: row.accountName },
      access.categories,
    );
    return [toEventMessage(event, opts.toast, access, opts.now)];
  });
}

/** The WHERE clause shared by both queries; null when the options can't match anything. */
function replayWindow(opts: ReplayOptions): SQL | null {
  const nowMs = opts.now.getTime();
  if (!Number.isFinite(nowMs) || !Number.isFinite(opts.maxAgeMs) || opts.maxAgeMs <= 0) return null;
  // A cursor that isn't a safe integer (NaN, 1e300) can't be compared exactly; start from 0 then.
  const afterSeq = Number.isSafeInteger(opts.afterSeq) ? Math.max(opts.afterSeq, 0) : 0;
  const cutoff = new Date(nowMs - opts.maxAgeMs);
  const parts: SQL[] = [
    gt(events.seq, afterSeq),
    gt(events.seq, seqFloor(new Date(cutoff.getTime() - RECEIVE_ORDER_SLACK_MS))),
    gt(events.receivedAt, cutoff),
  ];
  const settleMs = opts.settleMs ?? 0;
  if (Number.isFinite(settleMs) && settleMs > 0) {
    // inserted_at is clock_timestamp() at insert: compare with the database clock, not the app's.
    parts.push(
      sql`${events.insertedAt} <= clock_timestamp() - make_interval(secs => ${settleMs / 1000})`,
    );
  }
  return and(...parts) ?? null;
}

/**
 * The highest seq received at or before `before` (0 when none), so the window is an index range on
 * seq even when the client's cursor is 0 or far behind: `received_at` has no index, and without this
 * bound every poll would scan the whole events table. Found by walking the seq index backwards from
 * the newest row, which reads only the rows of the last few minutes. Evaluated once per query
 * (an InitPlan).
 */
function seqFloor(before: Date): SQL {
  return sql`coalesce((select ${events.seq} from ${events} where ${events.receivedAt} <= ${before} order by ${events.seq} desc limit 1), 0)`;
}

/** The accounts with events in the window whose `events` category the viewer may read. */
async function readableAccounts(
  db: DbOrTx,
  viewer: Viewer,
  window: SQL,
): Promise<Map<number, ResolvedAccess>> {
  const candidates = await db
    .selectDistinct({ accountId: events.accountId })
    .from(events)
    .where(window);
  const accessMap = await loadAccountAccess(
    db,
    candidates.map((c) => c.accountId),
  );
  const allowed = new Map<number, ResolvedAccess>();
  for (const [accountId, access] of accessMap) {
    const resolved = resolveAccess(viewer, access);
    if (resolved.categories.has('events')) allowed.set(accountId, resolved);
  }
  return allowed;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return REPLAY_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), REPLAY_MAX_LIMIT);
}
