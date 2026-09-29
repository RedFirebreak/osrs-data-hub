/**
 * GET /api/v1/leaderboards/gains?skill=&period=day|week|month (handoff §13, for the Discord bot): the
 * guild page's gains leaderboards over the accounts whose `stats` the key may read (D-70).
 */
import { apiLeaderboardGains } from '@hub/server';
import { preflight } from '@/lib/api-v1/cors';
import { parseQuery, v1Ok } from '@/lib/api-v1/respond';
import { LeaderboardQuery } from '@/lib/api-v1/schemas';
import { wireLeaderboards } from '@/lib/api-v1/wire';
import { withApiKey } from '@/lib/api-v1/with-api-key';

export async function GET(request: Request): Promise<Response> {
  return withApiKey(request, async ({ db, principal }) => {
    const q = parseQuery(request, LeaderboardQuery);
    const boards = await apiLeaderboardGains(db, principal, { skill: q.skill, period: q.period });
    return v1Ok(wireLeaderboards(boards));
  });
}

export const OPTIONS = preflight;
