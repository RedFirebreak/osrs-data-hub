/**
 * DELETE /api/app/friends/[id] → 200 `{ ok: true, offboarded }`: the member removes one of their
 * invites (D-117). A friend who signed in on it is offboarded with reason 'invite_removed', as a
 * member leaving the guild would be (`offboarded: true`). 404 for an invite that isn't the member's.
 * Session auth (401) and an Origin check (403 `bad_origin`, D-36). Audited as 'friend.removed'.
 */
import { getConfig } from '@hub/core';
import { getDb } from '@hub/db';
import { removeFriend } from '@hub/server';
import { ApiError, assertSameOrigin, handleApi, json } from '@/lib/http';
import { requireApiUser } from '@/lib/session';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(
  request: Request,
  ctx: RouteContext<'/api/app/friends/[id]'>,
): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { viewer } = await requireApiUser(request);
    const { id } = await ctx.params;
    if (!UUID.test(id)) throw new ApiError(404, 'not_found', 'That friend is not on your list.');
    const { offboarded } = await removeFriend(getDb().db, {
      actor: viewer,
      inviteId: id,
      graceDays: getConfig().offboardGraceDays,
    });
    return json(200, { ok: true, offboarded });
  });
}
