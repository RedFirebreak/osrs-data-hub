/**
 * GET /api/v1/accounts?names=&ids=&online= (handoff §13): the accounts the key may see (D-70), sorted
 * by name: id, name, type, and presence (online, world, last_seen) where the key reads `activity`.
 */
import { apiListAccounts } from '@hub/server';
import { preflight } from '@/lib/api-v1/cors';
import { parseQuery, v1Ok } from '@/lib/api-v1/respond';
import { AccountsQuery } from '@/lib/api-v1/schemas';
import { wireAccountSummary } from '@/lib/api-v1/wire';
import { withApiKey } from '@/lib/api-v1/with-api-key';

export async function GET(request: Request): Promise<Response> {
  return withApiKey(request, async ({ db, principal }) => {
    const q = parseQuery(request, AccountsQuery);
    const accounts = await apiListAccounts(db, principal, {
      names: q.names,
      ids: q.ids,
      online: q.online,
    });
    return v1Ok(accounts.map(wireAccountSummary), { count: accounts.length });
  });
}

export const OPTIONS = preflight;
