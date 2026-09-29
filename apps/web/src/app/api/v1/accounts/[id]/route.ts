/**
 * GET /api/v1/accounts/{id} (handoff §13): one account's current state by category. A section the key
 * can't read is omitted; one the plugin never sent is `{ shared: false, updated_at: null }`. Unknown,
 * out of scope and not shared are the same 404 (D-70).
 */
import { apiGetAccount } from '@hub/server';
import { preflight } from '@/lib/api-v1/cors';
import { accountIdFrom, found } from '@/lib/api-v1/respond';
import { wireAccountDetail } from '@/lib/api-v1/wire';
import { withApiKey } from '@/lib/api-v1/with-api-key';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/v1/accounts/[id]'>,
): Promise<Response> {
  return withApiKey(request, async ({ db, principal }) => {
    const id = await accountIdFrom(ctx.params);
    return found(await apiGetAccount(db, principal, id), wireAccountDetail);
  });
}

export const OPTIONS = preflight;
