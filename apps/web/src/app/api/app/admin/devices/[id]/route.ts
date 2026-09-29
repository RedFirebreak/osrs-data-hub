/**
 * DELETE /api/app/admin/devices/[id] → 200 `{ ok: true }`: an admin revokes any user's device
 * (handoff §12 Admin, reason 'admin', audited as 'device.revoked' with asAdmin). The token stops
 * working at once and the plugin disables the connection when its next send gets 401 (handoff §3.2).
 * Idempotent: an already revoked device answers 200 and keeps its original time and reason.
 *
 * 404 for an id that isn't a uuid or doesn't exist. Session auth (401), admins only (403), and an
 * Origin check (403 `bad_origin`, D-36).
 */
import { getDb } from '@hub/db';
import { revokeDevice } from '@hub/server';
import { ApiError, assertSameOrigin, handleApi, json } from '@/lib/http';
import { requireApiAdmin } from '../../guard';

export async function DELETE(
  request: Request,
  ctx: RouteContext<'/api/app/admin/devices/[id]'>,
): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { user } = await requireApiAdmin(request);
    const { id } = await ctx.params;
    const revoked = await revokeDevice(getDb().db, {
      deviceId: id,
      actorUserId: user.id,
      asAdmin: true,
      reason: 'admin',
    });
    if (!revoked) throw new ApiError(404, 'not_found', 'Device not found.');
    return json(200, { ok: true });
  });
}
