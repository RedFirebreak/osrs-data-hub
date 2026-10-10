/**
 * One service key (D-88, D-111), for admins:
 *
 * - PATCH `{ name?, categories?, rateLimitPerMinute? }` → 200 `{ info }`: edits what the key reads
 *   and its rate limit (updateServiceKey, UpdateServiceKeySchema). The key itself stays the same, so
 *   the integration using it keeps its configuration. 400 `invalid_request` with `details` for a body
 *   it refuses, 409 `conflict` for a key that is revoked or expired. Audited as
 *   'service_key.updated' when something changed.
 * - DELETE → 200 `{ ok: true }`: revokes the key; the next request with it gets 401. Idempotent (a
 *   revoked key answers 200 again). Audited as 'service_key.revoked'. Deleting a revoked key is POST
 *   [id]/delete.
 *
 * Both answer 404 for an id that isn't a uuid, doesn't exist or is a user's own key (all look the
 * same). Session auth (401), admins only (403), and an Origin check (403 `bad_origin`, D-36); a body
 * is capped at 64 KiB (413).
 */
import { getDb } from '@hub/db';
import { revokeServiceKey, updateServiceKey } from '@hub/server';
import { ApiError, assertSameOrigin, handleApi, json, readJson } from '@/lib/http';
import { requireApiAdmin } from '../../guard';

export async function PATCH(
  request: Request,
  ctx: RouteContext<'/api/app/admin/service-keys/[id]'>,
): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { viewer } = await requireApiAdmin(request);
    const { id } = await ctx.params;
    const input = await readJson(request);
    const info = await updateServiceKey(getDb().db, { actor: viewer, keyId: id, input });
    if (!info) throw new ApiError(404, 'not_found', 'Service key not found.');
    return json(200, { info });
  });
}

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
