/**
 * GET /api/v1/collection-log?item=&accounts=&limit= (D-131): the guild's collection log page (D-118)
 * through a key: the board, the newest slots and, with `item`, who has it, over every account whose
 * `events` or `hiscores` the key reads and that isn't hidden from the guild (D-104). An account named
 * in `accounts` that isn't one of those makes the whole request 404 (D-70).
 */
import { apiGuildCollectionLog } from '@hub/server';
import { preflight } from '@/lib/api-v1/cors';
import { v1Ok } from '@/lib/api-v1/respond';
import { CollectionLogQuery } from '@/lib/api-v1/schemas';
import { wireCollectionLog } from '@/lib/api-v1/wire';
import { withApiKey } from '@/lib/api-v1/with-api-key';
import { parseQuery } from '@/lib/query';

export async function GET(request: Request): Promise<Response> {
  return withApiKey(request, async ({ db, principal }) => {
    const q = parseQuery(request, CollectionLogQuery);
    const log = await apiGuildCollectionLog(db, principal, {
      item: q.item,
      accounts: q.accounts && q.accounts.length > 0 ? q.accounts : undefined,
      limit: q.limit,
    });
    return v1Ok(wireCollectionLog(log), { searchable: log.searchable, truncated: log.truncated });
  });
}

export const OPTIONS = preflight;
