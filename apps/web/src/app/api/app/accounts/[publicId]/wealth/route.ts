/**
 * GET /api/app/accounts/[publicId]/wealth?from=ISO&to=ISO → 200 `{ from, to, days }`: carried wealth
 * (inventory + equipment, GE value) per UTC day, oldest first (@hub/server getWealthHistory).
 * `inventory` category (handoff §10); 404 otherwise (see ../../history.ts). Defaults: the last 30
 * days.
 */
import { getWealthHistory } from '@hub/server';
import { historyResponse } from '../../history';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/app/accounts/[publicId]/wealth'>,
): Promise<Response> {
  return historyResponse(request, ctx.params, 'days', getWealthHistory);
}
