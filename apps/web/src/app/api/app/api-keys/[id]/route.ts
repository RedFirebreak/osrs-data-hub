/**
 * One of the signed-in user's API keys (D-76, D-111):
 *
 * - PATCH `{ name?, categories?, accountScope?, accountPublicIds? }` → 200 `{ info }`: edits what the
 *   key reads (updateApiKey, UpdateApiKeySchema). The key itself stays the same, so the app using it
 *   needs no change. 400 `invalid_request` with `details` for a body it refuses, 409 `conflict` for a
 *   key that is revoked or expired. Audited when something changed.
 * - DELETE → 204: revokes the key; the next request with it gets 401. Idempotent (a revoked key
 *   answers 204 again). Audited. Deleting a revoked key is POST [id]/delete.
 *
 * Both answer 404 for an id that isn't a uuid, doesn't exist or is another user's key (all look the
 * same). Session auth (401) and an Origin check (403, D-36); a body is capped at 64 KiB (413).
 */
import { getDb } from '@hub/db';
import { revokeApiKey, updateApiKey } from '@hub/server';
import { ApiError, assertSameOrigin, handleApi, json, readJson } from '@/lib/http';
import { requireApiUser } from '@/lib/session';

export async function PATCH(
  request: Request,
  ctx: RouteContext<'/api/app/api-keys/[id]'>,
): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { user } = await requireApiUser(request);
    const { id } = await ctx.params;
    const input = await readJson(request);
    const info = await updateApiKey(getDb().db, { userId: user.id, keyId: id, input });
    if (!info) throw new ApiError(404, 'not_found', 'API key not found.');
    return json(200, { info });
  });
}

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
