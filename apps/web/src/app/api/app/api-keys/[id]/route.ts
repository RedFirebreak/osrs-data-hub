/**
 * DELETE /api/app/api-keys/[id] — revokes one of the signed-in user's API keys (D-76): 204; the next
 * request with it gets 401. Idempotent (a revoked key answers 204 again). 404 for an id that isn't a
 * uuid, doesn't exist or is another user's key (all look the same). Audited.
 *
 * Session auth (401) and an Origin check (403, D-36).
 */
import { getDb } from '@hub/db';
import { revokeApiKey } from '@hub/server';
import { ApiError, assertSameOrigin, handleApi } from '@/lib/http';
import { requireApiUser } from '@/lib/session';

export async function DELETE(
  request: Request,
  ctx: RouteContext<'/api/app/api-keys/[id]'>,
): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { user } = await requireApiUser(request);
    const { id } = await ctx.params;
    const revoked = await revokeApiKey(getDb().db, { userId: user.id, keyId: id });
    if (!revoked) throw new ApiError(404, 'not_found', 'API key not found.');
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  });
}
