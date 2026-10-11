/**
 * The link to the guild's live map (D-115), set on Admin → Settings.
 *
 * PUT `{ enabled: <boolean>, url: <http(s) address> | "" | null }` → 200 `{ enabled, url }`: from
 * the next request on, every signed-in page shows "Map" in the top bar while `enabled`, opening
 * `url`. The address is kept while the link is off; turning it on needs one. Audited as
 * 'hub.map_link_changed'. Session auth (401), admins only (403), an Origin check (403 `bad_origin`,
 * D-36), a strict body (400).
 */
import { getDb } from '@hub/db';
import { MapLinkSchema, setMapLink } from '@hub/server';
import { assertSameOrigin, handleApi, json, readJson } from '@/lib/http';
import { requireApiAdmin } from '../guard';

export async function PUT(request: Request): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { user } = await requireApiAdmin(request);
    const body = MapLinkSchema.parse(await readJson(request));
    const link = await setMapLink(getDb().db, { link: body, actorUserId: user.id });
    return json(200, link);
  });
}
