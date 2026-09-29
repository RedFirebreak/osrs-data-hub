/**
 * GET /api/app/accounts/[publicId]/equipment?from=ISO&to=ISO → 200 `{ from, to, changes }`: the
 * equipment change log in the range, newest first (@hub/server getEquipmentHistory). `equipment`
 * category; 404 otherwise (see ../../history.ts). Defaults: the last 30 days.
 */
import { getEquipmentHistory } from '@hub/server';
import { historyResponse } from '../../history';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/app/accounts/[publicId]/equipment'>,
): Promise<Response> {
  return historyResponse(request, ctx.params, 'changes', getEquipmentHistory);
}
