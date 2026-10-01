/**
 * GET /api/v1/events?cursor=&types=&accounts=&min_value=&limit= (handoff §13, D-73): the cursor feed
 * for the Discord bot and Home Assistant. `data` is the page of events (oldest first), `meta.next_cursor`
 * the cursor to pass next time. Only events at least 10 s old are served (the settled prefix), so a
 * cursor never skips a row that commits late (DB-4).
 *
 * With `from` and/or `to` (D-98, for the live map's trails): the events that occurred in the range
 * instead, newest first, same filters and shape; `meta.next_cursor` is the next (older) page's
 * cursor, null on the last page. No settle margin: that order doesn't depend on commit order.
 */
import { apiEvents, apiEventsInRange } from '@hub/server';
import { preflight } from '@/lib/api-v1/cors';
import { v1Ok } from '@/lib/api-v1/respond';
import { EventsQuery } from '@/lib/api-v1/schemas';
import { wireEvent } from '@/lib/api-v1/wire';
import { withApiKey } from '@/lib/api-v1/with-api-key';
import { parseQuery } from '@/lib/query';

export async function GET(request: Request): Promise<Response> {
  return withApiKey(request, async ({ db, principal }) => {
    const q = parseQuery(request, EventsQuery);
    const params = {
      cursor: q.cursor,
      types: q.types,
      accountIds: q.accounts,
      minValue: q.min_value,
      limit: q.limit,
    };
    const page =
      q.from !== undefined || q.to !== undefined
        ? await apiEventsInRange(db, principal, { ...params, from: q.from, to: q.to })
        : await apiEvents(db, principal, params);
    return v1Ok(page.events.map(wireEvent), {
      count: page.events.length,
      next_cursor: page.nextCursor,
    });
  });
}

export const OPTIONS = preflight;
