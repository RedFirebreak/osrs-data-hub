/**
 * GET /api/v1/accounts/{id}/day?date= | ?from=&to= (M8, D-138): one account's day in one call, the
 * REST twin of the MCP tool `day_summary`: sessions, gains, events and places, each section only
 * where the key reads its category (none of them: the account 404, D-70). Dates are in the key
 * creator's time zone (UTC for a service key); default today, at most DAY_MAX_DAYS at once.
 */
import { apiDay } from '@hub/server';
import { preflight } from '@/lib/api-v1/cors';
import { accountIdFrom, found } from '@/lib/api-v1/respond';
import { DayQuery } from '@/lib/api-v1/schemas';
import { wireDay } from '@/lib/api-v1/wire';
import { withApiKey } from '@/lib/api-v1/with-api-key';
import { parseQuery } from '@/lib/query';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/v1/accounts/[id]/day'>,
): Promise<Response> {
  return withApiKey(request, async ({ db, principal }) => {
    const q = parseQuery(request, DayQuery);
    const id = await accountIdFrom(ctx.params);
    return found(await apiDay(db, principal, id, q), wireDay);
  });
}

export const OPTIONS = preflight;
