/**
 * GET /api/app/accounts/[publicId]/xp?skills=Attack,Overall&from=ISO&to=ISO&resolution=auto|5m|1h|1d
 * → 200 `XpSeries` (`{ resolution, series: [{ skill, points: [[iso, xp], …] }] }`, @hub/server
 * getXpSeries: last value per bucket, the value in effect at the range start prepended; handoff §9).
 *
 * Session auth (401). 404 when the account doesn't exist, isn't visible to the viewer, or the viewer
 * lacks its `stats` category (existence never leaks). 400 for a malformed query (parseXpQuery).
 */
import { getDb } from '@hub/db';
import { getXpSeries, isPublicIdLike } from '@hub/server';
import { accountNotFound, handleApi, json } from '@/lib/http';
import { requireApiUser } from '@/lib/session';
import { parseXpQuery } from '../../query';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/app/accounts/[publicId]/xp'>,
): Promise<Response> {
  return handleApi(async () => {
    const { viewer } = await requireApiUser(request);
    const { publicId } = await ctx.params;
    if (!isPublicIdLike(publicId)) throw accountNotFound();
    const query = parseXpQuery(request.url, new Date());
    const series = await getXpSeries(getDb().db, viewer, publicId, query);
    if (!series) throw accountNotFound();
    return json(200, series);
  });
}
