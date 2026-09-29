/**
 * POST /api/app/admin/users/[id]/restore → 200 `{ ok: true, unhidden }`: an admin brings a user in
 * grace back, whatever the reason (handoff §14.4, D-35): active again, their hidden accounts visible
 * (`unhidden` counts them, D-60 take-overs included). Devices stay revoked: they pair again through
 * the wizard. A no-op (200, 0) for a user who is already active; re-verification offboards them again
 * if Discord still says they left.
 *
 * 404 for an unknown user. Session auth (401), admins only (403), and an Origin check (403
 * `bad_origin`, D-36). No body.
 */
import { getDb } from '@hub/db';
import { adminRestoreUser } from '@hub/server';
import { assertSameOrigin, handleApi, json } from '@/lib/http';
import { requireApiAdmin } from '../../../guard';

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/app/admin/users/[id]/restore'>,
): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { viewer } = await requireApiAdmin(request);
    const { id } = await ctx.params;
    const { unhidden } = await adminRestoreUser(getDb().db, { actor: viewer, userId: id });
    return json(200, { ok: true, unhidden: unhidden.length });
  });
}
