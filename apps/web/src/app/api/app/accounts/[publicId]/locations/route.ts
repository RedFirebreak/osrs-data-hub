/**
 * GET /api/app/accounts/[publicId]/locations?from=ISO&to=ISO → 200 `{ from, to, points, truncated }`:
 * the location trail (every tile visited, kept LOCATION_RETENTION_DAYS), oldest first; at most 20,000
 * points, the newest, with `truncated` (@hub/server getLocationHistory, D-102). Snapshot coordinates
 * only; event locations are another coordinate space (PLUGIN-12). Defaults: the last 24 hours, as
 * the public API. Nothing draws the trail yet (ARCHITECTURE §14): the account page's other histories
 * are rendered on the server, straight from the read models.
 *
 * Session auth (401). 404 when the account doesn't exist, isn't visible to the viewer, or the viewer
 * lacks its `location_history` category (existence never leaks). 400 for a malformed range
 * (parseHistoryRange).
 */
import { getDb } from '@hub/db';
import { LOCATIONS_DEFAULT_HOURS, getLocationHistory, isPublicIdLike } from '@hub/server';
import { accountNotFound, handleApi, json } from '@/lib/http';
import { requireApiUser } from '@/lib/session';
import { parseHistoryRange } from '../../query';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/app/accounts/[publicId]/locations'>,
): Promise<Response> {
  return handleApi(async () => {
    const { viewer } = await requireApiUser(request);
    const { publicId } = await ctx.params;
    if (!isPublicIdLike(publicId)) throw accountNotFound();
    const range = parseHistoryRange(request.url, new Date(), LOCATIONS_DEFAULT_HOURS / 24);
    const trail = await getLocationHistory(getDb().db, viewer, publicId, range);
    if (trail === null) throw accountNotFound();
    return json(200, { from: range.from.toISOString(), to: range.to.toISOString(), ...trail });
  });
}
