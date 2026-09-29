/**
 * POST /api/app/admin/users/[id]/offboard → 200 `{ ok: true, transferred, hidden, revokedDevices,
 * deletedSessions }` (counts): an admin offboards a user (handoff §14, reason 'admin', D-25):
 * status → grace for OFFBOARD_GRACE_DAYS, devices and API keys revoked, sessions deleted, owned
 * accounts transferred to the longest-linked active contributor or hidden. Logging in again does not
 * undo it (D-35); only an admin's restore does. A user already in grace keeps their grace_until and
 * gets the reason 'admin'.
 *
 * 400 for the admin themselves, 404 for an unknown user. Session auth (401), admins only (403), and
 * an Origin check (403 `bad_origin`, D-36). No body.
 */
import { getConfig } from '@hub/core';
import { getDb } from '@hub/db';
import { adminOffboardUser } from '@hub/server';
import { assertSameOrigin, handleApi, json } from '@/lib/http';
import { requireApiAdmin } from '../../../guard';

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/app/admin/users/[id]/offboard'>,
): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { viewer } = await requireApiAdmin(request);
    const { id } = await ctx.params;
    const result = await adminOffboardUser(getDb().db, {
      actor: viewer,
      userId: id,
      graceDays: getConfig().offboardGraceDays,
    });
    return json(200, {
      ok: true,
      transferred: result.transferred.length,
      hidden: result.hidden.length,
      revokedDevices: result.revokedDevices,
      deletedSessions: result.deletedSessions,
    });
  });
}
