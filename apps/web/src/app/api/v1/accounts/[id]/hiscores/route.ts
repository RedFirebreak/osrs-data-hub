/**
 * GET /api/v1/accounts/{id}/hiscores (D-105): what the hub last read from the official hiscores
 * (`hiscores`; else the account 404, D-70).
 */
import { apiHiscores } from '@hub/server';
import { preflight } from '@/lib/api-v1/cors';
import { accountIdFrom, found } from '@/lib/api-v1/respond';
import { wireHiscores } from '@/lib/api-v1/wire';
import { withApiKey } from '@/lib/api-v1/with-api-key';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/v1/accounts/[id]/hiscores'>,
): Promise<Response> {
  return withApiKey(request, async ({ db, principal }) => {
    const id = await accountIdFrom(ctx.params);
    return found(await apiHiscores(db, principal, id), wireHiscores);
  });
}

export const OPTIONS = preflight;
