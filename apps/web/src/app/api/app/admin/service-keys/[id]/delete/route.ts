/**
 * POST /api/app/admin/service-keys/[id]/delete → 200 `{ ok: true }`: an admin deletes a service key
 * once it is revoked or expired (D-111), so it leaves Admin → Integrations. 409 `conflict` while the
 * key is still active (revoke it first: DELETE /api/app/admin/service-keys/[id]); 404 for an id that
 * isn't a uuid, doesn't exist (a key deleted already included) or is a user's own key. Audited as
 * 'service_key.deleted'.
 *
 * A route of its own because DELETE on the key already means "revoke" (D-88). Session auth (401),
 * admins only (403), and an Origin check (403 `bad_origin`, D-36).
 */
import { getDb } from '@hub/db';
import { deleteServiceKey } from '@hub/server';
import { ApiError, assertSameOrigin, handleApi, json } from '@/lib/http';
import { requireApiAdmin } from '../../../guard';

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/app/admin/service-keys/[id]/delete'>,
): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { viewer } = await requireApiAdmin(request);
    const { id } = await ctx.params;
    const deleted = await deleteServiceKey(getDb().db, { actor: viewer, keyId: id });
    if (!deleted) throw new ApiError(404, 'not_found', 'Service key not found.');
    return json(200, { ok: true });
  });
}
