/**
 * GET /api/v1/accounts/{id}/locations?from=&to= (handoff §13): the location trail, at most one point
 * per minute, oldest first (`location_history`; else the account 404, D-70). Default: the last 30
 * days (the trail's retention).
 */
import { apiLocations } from '@hub/server';
import { preflight } from '@/lib/api-v1/cors';
import { accountIdFrom, found } from '@/lib/api-v1/respond';
import { HistoryQuery } from '@/lib/api-v1/schemas';
import { wireLocations } from '@/lib/api-v1/wire';
import { withApiKey } from '@/lib/api-v1/with-api-key';
import { parseQuery } from '@/lib/query';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/v1/accounts/[id]/locations'>,
): Promise<Response> {
  return withApiKey(request, async ({ db, principal }) => {
    const q = parseQuery(request, HistoryQuery);
    const id = await accountIdFrom(ctx.params);
    return found(await apiLocations(db, principal, id, q), wireLocations);
  });
}

export const OPTIONS = preflight;
