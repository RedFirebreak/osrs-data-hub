/**
 * GET /api/app/feed?account=<publicId>&types=loot,level_up&before=<seq>&limit=<1…200> → 200
 * `{ events: FeedEvent[], nextBefore: number | null }`: the viewer's events feed, newest first by seq
 * (@hub/server listFeed: only accounts whose `events` category the viewer may see, every event
 * redacted for the viewer). "Load more" passes `before` = the seq of the last event shown;
 * `nextBefore` is that value for this page, or null when the page came back short (nothing older).
 * An account that doesn't exist or isn't visible gives an empty feed (existence never leaks).
 * Without `account` this is the guild page's activity feed, so the admin's guild feed filter applies
 * (getGuildFeedFilter, D-81); an account's own timeline is never filtered.
 *
 * Session auth (401); 400 for a malformed query (parseFeedQuery). Default limit 50.
 */
import { getDb } from '@hub/db';
import { FEED_DEFAULT_LIMIT, getGuildFeedFilter, listFeed } from '@hub/server';
import { handleApi, json } from '@/lib/http';
import { requireApiUser } from '@/lib/session';
import { parseFeedQuery } from '../accounts/query';

export async function GET(request: Request): Promise<Response> {
  return handleApi(async () => {
    const { viewer } = await requireApiUser(request);
    const query = parseFeedQuery(request.url);
    const limit = query.limit ?? FEED_DEFAULT_LIMIT;
    const { db } = getDb();
    const guildFilter =
      query.accountPublicId === undefined ? await getGuildFeedFilter(db) : undefined;
    const events = await listFeed(db, viewer, { ...query, limit, guildFilter });
    const last = events.at(-1);
    return json(200, { events, nextBefore: events.length >= limit && last ? last.seq : null });
  });
}
