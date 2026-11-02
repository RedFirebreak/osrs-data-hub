/**
 * GET /api/v1/accounts/{id}/collection-log?source=&since=&limit= (D-131): the account's collection
 * log page (D-118) through a key: the hiscores' "Collections Logged" (`hiscores`) and the slots the
 * hub saw (`events`); without either, the account 404 (D-70).
 */
import { apiAccountCollectionLog } from '@hub/server';
import { preflight } from '@/lib/api-v1/cors';
import { accountIdFrom, v1Ok } from '@/lib/api-v1/respond';
import { AccountCollectionLogQuery } from '@/lib/api-v1/schemas';
import { wireAccountCollectionLog } from '@/lib/api-v1/wire';
import { withApiKey } from '@/lib/api-v1/with-api-key';
import { accountNotFound } from '@/lib/http';
import { parseQuery } from '@/lib/query';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/v1/accounts/[id]/collection-log'>,
): Promise<Response> {
  return withApiKey(request, async ({ db, principal }) => {
    const id = await accountIdFrom(ctx.params);
    const q = parseQuery(request, AccountCollectionLogQuery);
    const log = await apiAccountCollectionLog(db, principal, id, q);
    if (log === null) throw accountNotFound();
    return v1Ok(wireAccountCollectionLog(log), {
      count: log.slots?.length ?? 0,
      truncated: log.truncated,
    });
  });
}

export const OPTIONS = preflight;
