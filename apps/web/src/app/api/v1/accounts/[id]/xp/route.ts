/**
 * GET /api/v1/accounts/{id}/xp?skills=&from=&to=&resolution=auto|5m|1h|1d (handoff §13): XP series of
 * one account (`stats`; else the account 404, D-70). Defaults: Overall, the last 7 days, auto.
 */
import { apiXp } from '@hub/server';
import { preflight } from '@/lib/api-v1/cors';
import { accountIdFrom, found, parseQuery } from '@/lib/api-v1/respond';
import { XpQuery } from '@/lib/api-v1/schemas';
import { wireXpSeries } from '@/lib/api-v1/wire';
import { withApiKey } from '@/lib/api-v1/with-api-key';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/v1/accounts/[id]/xp'>,
): Promise<Response> {
  return withApiKey(request, async ({ db, principal }) => {
    const q = parseQuery(request, XpQuery);
    const id = await accountIdFrom(ctx.params);
    const series = await apiXp(db, principal, id, {
      skills: q.skills,
      from: q.from,
      to: q.to,
      resolution: q.resolution,
    });
    return found(series, wireXpSeries);
  });
}

export const OPTIONS = preflight;
