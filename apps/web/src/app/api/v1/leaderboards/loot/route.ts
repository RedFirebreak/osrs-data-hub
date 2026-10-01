/**
 * GET /api/v1/leaderboards/loot?period=day|week|month&limit= (D-94, for the live map): the period's
 * most valuable loot and PK loot over the accounts whose `events` the key may read (D-70), each
 * event exactly as /events serves it.
 */
import { apiLootLeaderboard } from '@hub/server';
import { preflight } from '@/lib/api-v1/cors';
import { v1Ok } from '@/lib/api-v1/respond';
import { LootLeaderboardQuery } from '@/lib/api-v1/schemas';
import { wireLootLeaderboard } from '@/lib/api-v1/wire';
import { withApiKey } from '@/lib/api-v1/with-api-key';
import { parseQuery } from '@/lib/query';

export async function GET(request: Request): Promise<Response> {
  return withApiKey(request, async ({ db, principal }) => {
    const q = parseQuery(request, LootLeaderboardQuery);
    const board = await apiLootLeaderboard(db, principal, { period: q.period, limit: q.limit });
    return v1Ok(wireLootLeaderboard(board));
  });
}

export const OPTIONS = preflight;
