/**
 * GET /api/v1/snapshot?since= (handoff §13, D-74): the current state of every account the key may
 * see, for polling every 2–10 s (the live map, Home Assistant). Limited to 1 request per second per
 * key on top of the general limit.
 *
 * Conditional: the weak ETag covers the key and the response content, so `If-None-Match` with the
 * last ETag answers 304 (no body; the ETag, CORS and rate-limit headers) while nothing a consumer
 * would see has changed. `Cache-Control: private, no-cache` lets a browser keep the body and
 * revalidate every time. `Last-Modified` (when known) and `meta.last_modified` give the next `since`.
 */
import { apiSnapshot, etagMatches } from '@hub/server';
import { preflight } from '@/lib/api-v1/cors';
import { v1Ok } from '@/lib/api-v1/respond';
import { SnapshotQuery } from '@/lib/api-v1/schemas';
import { wireSnapshotAccount } from '@/lib/api-v1/wire';
import { withApiKey } from '@/lib/api-v1/with-api-key';
import { parseQuery } from '@/lib/query';

export async function GET(request: Request): Promise<Response> {
  return withApiKey(
    request,
    async ({ db, principal }) => {
      const q = parseQuery(request, SnapshotQuery);
      const snapshot = await apiSnapshot(db, principal, { since: q.since });
      const headers: Record<string, string> = {
        ETag: snapshot.etag,
        'Cache-Control': 'private, no-cache',
      };
      if (snapshot.lastModified !== null) {
        headers['Last-Modified'] = new Date(snapshot.lastModified).toUTCString();
      }
      if (etagMatches(request.headers.get('if-none-match'), snapshot.etag)) {
        return new Response(null, { status: 304, headers });
      }
      return v1Ok(
        snapshot.accounts.map(wireSnapshotAccount),
        { count: snapshot.accounts.length, last_modified: snapshot.lastModified },
        headers,
      );
    },
    { snapshot: true },
  );
}

export const OPTIONS = preflight;
