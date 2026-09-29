/**
 * The guild activity feed's filter (D-81), set on Admin → Settings.
 *
 * PUT `{ minLootValue: <0…2^31 gp>, showVirtualLevels: <boolean> }` → 200 `{ minLootValue,
 * showVirtualLevels }`: from the next request on, the guild page's activity feed (and GET
 * /api/app/feed without `account`) leaves out loot and PK loot below the minimum, and level-ups past
 * 99 unless allowed. Nothing is deleted; account timelines, toasts and the API are not filtered.
 * Audited as 'hub.guild_feed_changed'. Session auth (401), admins only (403), an Origin check (403
 * `bad_origin`, D-36), a strict body (400).
 */
import { getDb } from '@hub/db';
import { GuildFeedFilterSchema, setGuildFeedFilter } from '@hub/server';
import { assertSameOrigin, handleApi, json, readJson } from '@/lib/http';
import { requireApiAdmin } from '../guard';

export async function PUT(request: Request): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { user } = await requireApiAdmin(request);
    const body = GuildFeedFilterSchema.parse(await readJson(request));
    const filter = await setGuildFeedFilter(getDb().db, { filter: body, actorUserId: user.id });
    return json(200, filter);
  });
}
