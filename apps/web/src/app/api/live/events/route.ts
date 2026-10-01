/**
 * GET /api/live/events?after=<seq> — the polling fallback of the live stream (handoff §11: every
 * 10 s when EventSource isn't available). Session auth; 401 JSON when signed out.
 *
 * - `after` absent or invalid (the first poll): `{ events: [], cursor }` with the current settled
 *   cursor (settledLiveCursor). Never a replay: a first poll that returned the last 5 minutes would
 *   toast old events.
 * - `after` = a seq, 0 included: `{ events, cursor }` — the viewer's events after it from the last
 *   5 minutes (permission-checked, redacted, toast-flagged by replayEvents) and the cursor for the
 *   next poll (the last event's seq, or `after` when there were none). 0 is the cursor a first poll
 *   hands out on a hub without events yet; reading it as "no cursor" would skip the hub's first
 *   events for a client that only polls.
 *
 * Both only ever hand out seqs that can no longer be overtaken by a slower transaction (DB-4): the
 * replay passes LIVE_POLL_SETTLE_MS, and the first cursor stops below the first row younger than it.
 */
import { getDb } from '@hub/db';
import {
  LIVE_POLL_SETTLE_MS,
  LIVE_REPLAY_MAX_AGE_MS,
  getUserSettings,
  replayEvents,
  settledLiveCursor,
} from '@hub/server';
import { handleApi, json } from '@/lib/http';
import { parseSeq } from '@/lib/query';
import { requireApiUser } from '@/lib/session';

export async function GET(request: Request): Promise<Response> {
  return handleApi(async () => {
    const { user, viewer } = await requireApiUser(request);
    const db = getDb().db;
    const after = parseSeq(new URL(request.url).searchParams.get('after'));
    if (after === null) {
      return json(200, { events: [], cursor: await settledLiveCursor(db) });
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
