/**
 * GET /api/v1/accounts/{id}/progress?range= | ?from=&to= (D-139): the account's Progress page as
 * data, the REST twin of the MCP tool `progress`: playtime and active time (`activity` and `stats`),
 * XP (`stats`), loot (`events`), boss kills (`hiscores`), the change in wealth (`inventory`) and the
 * goals, each section only where the key reads its category (none of them: the account 404, D-70).
 */
import { apiProgress } from '@hub/server';
import { preflight } from '@/lib/api-v1/cors';
import { accountIdFrom, found } from '@/lib/api-v1/respond';
import { ProgressQuery } from '@/lib/api-v1/schemas';
import { wireProgress } from '@/lib/api-v1/wire';
import { withApiKey } from '@/lib/api-v1/with-api-key';
import { parseQuery } from '@/lib/query';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/v1/accounts/[id]/progress'>,
): Promise<Response> {
  return withApiKey(request, async ({ db, principal }) => {
    const q = parseQuery(request, ProgressQuery);
    const id = await accountIdFrom(ctx.params);
    return found(await apiProgress(db, principal, id, q), wireProgress);
  });
}

export const OPTIONS = preflight;
