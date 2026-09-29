/**
 * GET /api/v1/xp?accounts=a,b&skills=&from=&to=&resolution= (handoff §13): XP series of several
 * accounts in request order. Each must be one whose `stats` the key may read, else 404 naming it
 * (like an unknown id, D-70).
 */
import { apiXpMulti } from '@hub/server';
import { preflight } from '@/lib/api-v1/cors';
import { parseQuery, v1Ok } from '@/lib/api-v1/respond';
import { XpMultiQuery } from '@/lib/api-v1/schemas';
import { wireXpMulti } from '@/lib/api-v1/wire';
import { withApiKey } from '@/lib/api-v1/with-api-key';

export async function GET(request: Request): Promise<Response> {
  return withApiKey(request, async ({ db, principal }) => {
    const q = parseQuery(request, XpMultiQuery);
    const series = await apiXpMulti(db, principal, {
      ids: q.accounts,
      skills: q.skills,
      from: q.from,
      to: q.to,
      resolution: q.resolution,
    });
    return v1Ok(wireXpMulti(series));
  });
}

export const OPTIONS = preflight;
