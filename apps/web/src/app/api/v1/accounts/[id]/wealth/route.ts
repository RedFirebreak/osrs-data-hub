/**
 * GET /api/v1/accounts/{id}/wealth?from=&to= (handoff §13): carried wealth per UTC day, oldest first
 * (`inventory`; else the account 404, D-70). Default: the last 30 days.
 */
import { apiWealth } from '@hub/server';
import { preflight } from '@/lib/api-v1/cors';
import { accountIdFrom, found } from '@/lib/api-v1/respond';
import { HistoryQuery } from '@/lib/api-v1/schemas';
import { wireWealth } from '@/lib/api-v1/wire';
import { withApiKey } from '@/lib/api-v1/with-api-key';
import { parseQuery } from '@/lib/query';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/v1/accounts/[id]/wealth'>,
): Promise<Response> {
  return withApiKey(request, async ({ db, principal }) => {
    const q = parseQuery(request, HistoryQuery);
    const id = await accountIdFrom(ctx.params);
    return found(await apiWealth(db, principal, id, q), wireWealth);
  });
}

export const OPTIONS = preflight;
