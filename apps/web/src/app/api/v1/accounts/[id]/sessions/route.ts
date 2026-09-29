/**
 * GET /api/v1/accounts/{id}/sessions?from=&to= (handoff §13): play sessions overlapping the range,
 * newest first (`activity`; else the account 404, D-70). Default: the last 30 days.
 */
import { apiSessions } from '@hub/server';
import { preflight } from '@/lib/api-v1/cors';
import { accountIdFrom, found, parseQuery } from '@/lib/api-v1/respond';
import { HistoryQuery } from '@/lib/api-v1/schemas';
import { wireSessions } from '@/lib/api-v1/wire';
import { withApiKey } from '@/lib/api-v1/with-api-key';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/v1/accounts/[id]/sessions'>,
): Promise<Response> {
  return withApiKey(request, async ({ db, principal }) => {
    const q = parseQuery(request, HistoryQuery);
    const id = await accountIdFrom(ctx.params);
    return found(await apiSessions(db, principal, id, q), wireSessions);
  });
}

export const OPTIONS = preflight;
