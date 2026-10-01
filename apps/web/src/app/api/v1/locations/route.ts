/**
 * GET /api/v1/locations?accounts=a,b&from=&to= (D-92): the location trails of several accounts in
 * one call, in request order, each exactly what /accounts/{id}/locations returns for the same range
 * (`location_history`, at most one point per minute, kept 30 days). Up to 10 accounts with a user
 * key, 50 with a service key; an account the key can't read makes the whole request the one 404
 * (D-70). Default: the last 30 days.
 */
import { apiLocationsMulti } from '@hub/server';
import { preflight } from '@/lib/api-v1/cors';
import { v1Ok } from '@/lib/api-v1/respond';
import { LocationsMultiQuery } from '@/lib/api-v1/schemas';
import { wireLocationsMulti } from '@/lib/api-v1/wire';
import { withApiKey } from '@/lib/api-v1/with-api-key';
import { parseQuery } from '@/lib/query';

export async function GET(request: Request): Promise<Response> {
  return withApiKey(request, async ({ db, principal }) => {
    const q = parseQuery(request, LocationsMultiQuery);
    const trails = await apiLocationsMulti(db, principal, {
      ids: q.accounts,
      from: q.from,
      to: q.to,
    });
    return v1Ok(wireLocationsMulti(trails));
  });
}

export const OPTIONS = preflight;
