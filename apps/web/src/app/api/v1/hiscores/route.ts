/**
 * GET /api/v1/hiscores?accounts=a,b (D-105): what the hub read from the official hiscores for
 * several accounts, in request order (`hiscores`; up to 10 with a user key, 50 with a service key,
 * D-92); an account the key can't read makes the whole request the one 404 (D-70). Without
 * `accounts`, every visible account whose `hiscores` the key reads.
 */
import { apiHiscoresMulti } from '@hub/server';
import { preflight } from '@/lib/api-v1/cors';
import { v1Ok } from '@/lib/api-v1/respond';
import { HiscoresMultiQuery } from '@/lib/api-v1/schemas';
import { wireHiscores } from '@/lib/api-v1/wire';
import { withApiKey } from '@/lib/api-v1/with-api-key';
import { parseQuery } from '@/lib/query';

export async function GET(request: Request): Promise<Response> {
  return withApiKey(request, async ({ db, principal }) => {
    const q = parseQuery(request, HiscoresMultiQuery);
    const accounts = await apiHiscoresMulti(db, principal, {
      ids: q.accounts && q.accounts.length > 0 ? q.accounts : undefined,
    });
    return v1Ok(accounts.map(wireHiscores), { count: accounts.length });
  });
}

export const OPTIONS = preflight;
