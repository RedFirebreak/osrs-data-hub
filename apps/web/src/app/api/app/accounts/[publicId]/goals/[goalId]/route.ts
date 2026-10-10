/**
 * One Metrics goal of an account (D-109).
 *
 * - DELETE → 204: removes it (@hub/server deleteGoal). 404 for an account the viewer can't see or a
 *   goal it doesn't have, 403 forbidden for anyone but the owner.
 *
 * Session auth (401) and the Origin check (CSRF, 403 `bad_origin`, D-36).
 */
import { deleteGoal, isPublicIdLike } from '@hub/server';
import { getDb } from '@hub/db';
import { ApiError, accountNotFound, assertSameOrigin, handleApi } from '@/lib/http';
import { requireApiUser } from '@/lib/session';

export async function DELETE(
  request: Request,
  ctx: RouteContext<'/api/app/accounts/[publicId]/goals/[goalId]'>,
): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { viewer } = await requireApiUser(request);
    const { publicId, goalId } = await ctx.params;
    if (!isPublicIdLike(publicId)) throw accountNotFound();
    if (!(await deleteGoal(getDb().db, viewer, publicId, goalId))) {
      throw new ApiError(404, 'not_found', 'Goal not found.');
    }
    return new Response(null, { status: 204 });
  });
}
