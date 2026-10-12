/**
 * DELETE /api/app/admin/friend-blacklist/[username] → 200 `{ ok: true }`: an admin takes a Discord
 * username off the blacklist (D-117), so it can be invited again. 404 when it isn't on it. Session
 * auth (401), admins only (403), an Origin check (403 `bad_origin`, D-36). Audited as
 * 'friend.unblacklisted'.
 */
import { getDb } from '@hub/db';
import { unblacklistFriend } from '@hub/server';
import { assertSameOrigin, handleApi, json } from '@/lib/http';
import { requireApiAdmin } from '../../guard';

export async function DELETE(
  request: Request,
  ctx: RouteContext<'/api/app/admin/friend-blacklist/[username]'>,
): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { viewer } = await requireApiAdmin(request);
    const { username } = await ctx.params;
    await unblacklistFriend(getDb().db, { actor: viewer, username });
    return json(200, { ok: true });
  });
}
