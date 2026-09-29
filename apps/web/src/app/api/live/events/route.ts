/**
 * GET /api/live/events?after=<seq> — the polling fallback of the live stream (handoff §11: every
 * 10 s when EventSource isn't available). Session auth; 401 JSON when signed out.
 *
 * - `after` absent, 0 or invalid (the first poll): `{ events: [], cursor }` with the current settled
 *   cursor. Never a replay: a first poll that returned the last 5 minutes would toast old events.
 * - `after` = a positive seq: `{ events, cursor }` — the viewer's events after it from the last
 *   5 minutes (permission-checked, redacted, toast-flagged by replayEvents) and the cursor for the
 *   next poll (the last event's seq, or `after` when there were none).
 *
 * Both only ever hand out seqs that can no longer be overtaken by a slower transaction (DB-4): the
 * replay passes LIVE_POLL_SETTLE_MS, and the first cursor stops below the first row younger than it.
 */
import { events, getDb, type Db } from '@hub/db';
import {
  LIVE_POLL_SETTLE_MS,
  LIVE_REPLAY_MAX_AGE_MS,
  getUserSettings,
  replayEvents,
} from '@hub/server';
import { sql } from 'drizzle-orm';
import { handleApi, json } from '@/lib/http';
import { requireApiUser } from '@/lib/session';

export async function GET(request: Request): Promise<Response> {
  return handleApi(async () => {
    const { user, viewer } = await requireApiUser(request);
    const db = getDb().db;
    const after = parseAfter(new URL(request.url).searchParams.get('after'));
    if (after === null) {
      return json(200, { events: [], cursor: await settledCursor(db) });
    }
    const { toast } = await getUserSettings(db, user.id);
    const messages = await replayEvents(db, viewer, {
      afterSeq: after,
      maxAgeMs: LIVE_REPLAY_MAX_AGE_MS,
      now: new Date(),
      toast,
      settleMs: LIVE_POLL_SETTLE_MS,
    });
    const cursor = messages.at(-1)?.event.seq ?? after;
    return json(200, { events: messages, cursor });
  });
}

/** A positive safe integer, else null ("no cursor yet"). */
function parseAfter(raw: string | null): number | null {
  const value = raw?.trim() ?? '';
  if (!/^\d{1,16}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * The highest seq a poller may start after (0 for an empty table): the newest seq below the first
 * row inserted less than LIVE_POLL_SETTLE_MS ago (database clock), so no lower seq can still commit
 * after it (DB-4, as replayEvents' settledCeiling). `floor` — the newest seq received more than two
 * minutes ago — is settled by far (ingest's lock and statement timeouts are seconds) and bounds both
 * scans to the seq index range of the last two minutes (received_at and inserted_at have no index).
 */
async function settledCursor(db: Db): Promise<number> {
  const settleSecs = LIVE_POLL_SETTLE_MS / 1000;
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
            AND y.inserted_at > clock_timestamp() - make_interval(secs => ${settleSecs})
        ), ${Number.MAX_SAFE_INTEGER})
    ), 0)) AS cursor
    FROM f`);
  return Number(result.rows[0]?.cursor ?? 0);
}
