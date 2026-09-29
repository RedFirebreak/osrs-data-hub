/**
 * GET /api/app/accounts/[publicId]/locations?from=ISO&to=ISO → 200 `{ from, to, points }`: the
 * location trail (≤ 1 sample a minute, kept LOCATION_RETENTION_DAYS), oldest first (@hub/server
 * getLocationHistory). Snapshot coordinates only; event locations are another coordinate space
 * (PLUGIN-12). `location_history` category; 404 otherwise (see ../../history.ts). Defaults: the last
 * 30 days.
 */
import { getLocationHistory } from '@hub/server';
import { historyResponse } from '../../history';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/app/accounts/[publicId]/locations'>,
): Promise<Response> {
  return historyResponse(request, ctx.params, 'points', getLocationHistory);
}
