/**
 * GET /api/app/pairing-codes/[id] — the pairing wizard's polling fallback while the live stream is
 * down (handoff §6.3, §11): the state of one of the signed-in user's own codes, and the first data
 * of the device it created.
 *
 * → 200 `{ code, device }`:
 * - `code`: getPairingCodeStatus — `{ id, code, status: 'active'|'consumed'|'expired', expiresAt,
 *   deviceId, outdatedAttemptAt, outdatedVersion }` (dates as ISO strings). `outdatedAttemptAt` is
 *   set when a plugin below MIN_PLUGIN_VERSION tried the code (the code is not consumed then);
 * - `device`: getDeviceFirstData for the code's device (`{ account, role, ownerName }`), null until
 *   the device has reported an account, and while the code isn't consumed.
 *
 * 404 for an id that isn't a uuid, doesn't exist or is another user's code (all look the same).
 * Session auth (401).
 */
import { getDb } from '@hub/db';
import { getDeviceFirstData, getPairingCodeStatus } from '@hub/server';
import { ApiError, handleApi, json } from '@/lib/http';
import { requireApiUser } from '@/lib/session';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/app/pairing-codes/[id]'>,
): Promise<Response> {
  return handleApi(async () => {
    const { user } = await requireApiUser(request);
    const { id } = await ctx.params;
    const { db } = getDb();
    const code = await getPairingCodeStatus(db, { userId: user.id, codeId: id });
    if (!code) throw new ApiError(404, 'not_found', 'Pairing code not found.');
    const device =
      code.deviceId === null
        ? null
        : await getDeviceFirstData(db, { userId: user.id, deviceId: code.deviceId });
    return json(200, { code, device });
  });
}
