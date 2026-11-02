/**
 * GET /api/v1/leaderboards/kills?boss=&period=week|month (D-139): the guild page's boss leaderboards
 * (D-110), boss kills gained over the last 7 or 30 days, over the accounts whose `hiscores` the key
 * may read (D-70) and that aren't hidden from the guild.
 */
import { apiKillsLeaderboard } from '@hub/server';
import { preflight } from '@/lib/api-v1/cors';
import { v1Ok } from '@/lib/api-v1/respond';
import { KillsLeaderboardQuery } from '@/lib/api-v1/schemas';
import { wireKillsLeaderboard } from '@/lib/api-v1/wire';
import { withApiKey } from '@/lib/api-v1/with-api-key';
import { parseQuery } from '@/lib/query';

export async function GET(request: Request): Promise<Response> {
  return withApiKey(request, async ({ db, principal }) => {
    const q = parseQuery(request, KillsLeaderboardQuery);
    const boards = await apiKillsLeaderboard(db, principal, { boss: q.boss, period: q.period });
    return v1Ok(wireKillsLeaderboard(boards));
  });
}

export const OPTIONS = preflight;
