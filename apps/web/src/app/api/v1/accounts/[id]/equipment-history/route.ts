/**
 * GET /api/v1/accounts/{id}/equipment-history?from=&to= (handoff §13): the equipment change log,
 * newest first (`equipment`; else the account 404, D-70). Default: the last 30 days.
 */
import { apiEquipmentHistory } from '@hub/server';
import { preflight } from '@/lib/api-v1/cors';
import { accountIdFrom, found, parseQuery } from '@/lib/api-v1/respond';
import { HistoryQuery } from '@/lib/api-v1/schemas';
import { wireEquipmentHistory } from '@/lib/api-v1/wire';
import { withApiKey } from '@/lib/api-v1/with-api-key';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/v1/accounts/[id]/equipment-history'>,
): Promise<Response> {
  return withApiKey(request, async ({ db, principal }) => {
    const q = parseQuery(request, HistoryQuery);
    const id = await accountIdFrom(ctx.params);
    return found(await apiEquipmentHistory(db, principal, id, q), wireEquipmentHistory);
  });
}

export const OPTIONS = preflight;
