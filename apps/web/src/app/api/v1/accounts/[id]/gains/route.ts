/**
 * GET /api/v1/accounts/{id}/gains?period=day|week|month|year (or from&to) (handoff §13): XP gained per
 * skill (`stats`; else the account 404, D-70). Default period: day, in the key creator's time zone.
 */
import { apiGains } from '@hub/server';
import { preflight } from '@/lib/api-v1/cors';
import { accountIdFrom, found, parseQuery } from '@/lib/api-v1/respond';
import { GainsQuery } from '@/lib/api-v1/schemas';
import { wireGains } from '@/lib/api-v1/wire';
import { withApiKey } from '@/lib/api-v1/with-api-key';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/v1/accounts/[id]/gains'>,
): Promise<Response> {
  return withApiKey(request, async ({ db, principal }) => {
    const q = parseQuery(request, GainsQuery);
    const id = await accountIdFrom(ctx.params);
    const gains = await apiGains(db, principal, id, { period: q.period, from: q.from, to: q.to });
    return found(gains, wireGains);
  });
}

export const OPTIONS = preflight;
