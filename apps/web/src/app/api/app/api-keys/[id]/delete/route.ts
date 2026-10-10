/**
 * POST /api/app/api-keys/[id]/delete → 204: deletes one of the signed-in user's keys once it is
 * revoked or expired (D-111), so it leaves the API keys page. 409 `conflict` while the key is still
 * active (revoke it first: DELETE /api/app/api-keys/[id]); 404 for an id that isn't a uuid, doesn't
 * exist (a key deleted already included) or is another user's key. Audited as 'api_key.deleted'.
 *
 * A route of its own because DELETE on the key already means "revoke" (D-76). Session auth (401) and
 * an Origin check (403, D-36).
 */
import { getDb } from '@hub/db';
import { deleteApiKey } from '@hub/server';
import { ApiError, assertSameOrigin, handleApi } from '@/lib/http';
import { requireApiUser } from '@/lib/session';

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/app/api-keys/[id]/delete'>,
): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { user } = await requireApiUser(request);
    const { id } = await ctx.params;
    const deleted = await deleteApiKey(getDb().db, { userId: user.id, keyId: id });
    if (!deleted) throw new ApiError(404, 'not_found', 'API key not found.');
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  });
}
