/**
 * One of the signed-in user's devices (handoff §6.3 Devices page).
 *
 * - PATCH `{ label: string | null }` → 200 `{ device: { id, label } }` with the label as stored
 *   (trimmed, control characters removed, ≤ 64 characters, empty → null). Revoked devices can be
 *   renamed too.
 * - DELETE → revokes the device (reason 'user') → 200 `{ ok: true }`. Idempotent: revoking a revoked
 *   device answers 200 again. The token stops working at once; the plugin disables the connection
 *   when its next send gets 401 (handoff §3.2), so a revoke is final — re-pairing makes a new device.
 *
 * 404 for an id that isn't a uuid, doesn't exist or is another user's device (all look the same).
 * Session auth (401) and an Origin check (403, D-36) on both.
 */
import { getDb } from '@hub/db';
import { normalizeDeviceLabel, renameDevice, revokeDevice } from '@hub/server';
import { z } from 'zod';
import { ApiError, assertSameOrigin, handleApi, json, readJson } from '@/lib/http';
import { requireApiUser } from '@/lib/session';
import { labelInput } from '../label';

const renameSchema = z.strictObject({ label: labelInput.nullable() });

function notFound(): ApiError {
  return new ApiError(404, 'not_found', 'Device not found.');
}

export async function PATCH(
  request: Request,
  ctx: RouteContext<'/api/app/devices/[id]'>,
): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { user } = await requireApiUser(request);
    const { id } = await ctx.params;
    const { label } = renameSchema.parse(await readJson(request));
    const renamed = await renameDevice(getDb().db, { userId: user.id, deviceId: id, label });
    if (!renamed) throw notFound();
    return json(200, { device: { id, label: normalizeDeviceLabel(label) } });
  });
}

export async function DELETE(
  request: Request,
  ctx: RouteContext<'/api/app/devices/[id]'>,
): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { user } = await requireApiUser(request);
    const { id } = await ctx.params;
    const revoked = await revokeDevice(getDb().db, {
      deviceId: id,
      actorUserId: user.id,
      reason: 'user',
    });
    if (!revoked) throw notFound();
    return json(200, { ok: true });
  });
}
