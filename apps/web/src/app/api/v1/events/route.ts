/**
 * GET /api/v1/events?cursor=&types=&accounts=&min_value=&limit= (handoff §13, D-73): the cursor feed
 * for the Discord bot and Home Assistant. `data` is the page of events (oldest first), `meta.next_cursor`
 * the cursor to pass next time. Only events at least 10 s old are served (the settled prefix), so a
 * cursor never skips a row that commits late (DB-4).
 */
import { apiEvents } from '@hub/server';
import { preflight } from '@/lib/api-v1/cors';
import { parseQuery, v1Ok } from '@/lib/api-v1/respond';
import { EventsQuery } from '@/lib/api-v1/schemas';
import { wireEvent } from '@/lib/api-v1/wire';
import { withApiKey } from '@/lib/api-v1/with-api-key';

export async function GET(request: Request): Promise<Response> {
  return withApiKey(request, async ({ db, principal }) => {
    const q = parseQuery(request, EventsQuery);
    const page = await apiEvents(db, principal, {
      cursor: q.cursor,
      types: q.types,
      accountIds: q.accounts,
      minValue: q.min_value,
      limit: q.limit,
    });
    return v1Ok(page.events.map(wireEvent), {
      count: page.events.length,
      next_cursor: page.nextCursor,
    });
  });
}

export const OPTIONS = preflight;
