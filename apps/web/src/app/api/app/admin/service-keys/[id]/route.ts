/**
 * DELETE /api/app/admin/service-keys/[id] → 200 `{ ok: true }`: an admin revokes a service key
 * (D-87); the next request with it gets 401. Idempotent (a revoked key answers 200 again). 404 for
 * an id that isn't a uuid, doesn't exist or is a user's own key (all look the same). Audited as
 * 'service_key.revoked'.
 *
 * Session auth (401), admins only (403), and an Origin check (403 `bad_origin`, D-36).
 */
import { getDb } from '@hub/db';
import { revokeServiceKey } from '@hub/server';
import { ApiError, assertSameOrigin, handleApi, json } from '@/lib/http';
import { requireApiAdmin } from '../../guard';

export async function DELETE(
  request: Request,
  ctx: RouteContext<'/api/app/admin/service-keys/[id]'>,
): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { viewer } = await requireApiAdmin(request);
    const { id } = await ctx.params;
    const revoked = await revokeServiceKey(getDb().db, { actor: viewer, keyId: id });
    if (!revoked) throw new ApiError(404, 'not_found', 'Service key not found.');
    return json(200, { ok: true });
  });
}
