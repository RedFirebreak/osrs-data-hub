/**
 * Invite a friend (D-117), set on Admin → Settings.
 *
 * PUT `{ enabled: <boolean>, maxPerMember: <1…25> }` → 200 `{ enabled, maxPerMember }`: whether
 * members may invite friends, and how many each may have. Off stops new invites only; friends already
 * in keep their access. Audited as 'hub.invite_friends_changed'. Session auth (401), admins only
 * (403), an Origin check (403 `bad_origin`, D-36), a strict body (400).
 */
import { getDb } from '@hub/db';
import { InviteFriendsSchema, setInviteFriends } from '@hub/server';
import { assertSameOrigin, handleApi, json, readJson } from '@/lib/http';
import { requireApiAdmin } from '../guard';

export async function PUT(request: Request): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { user } = await requireApiAdmin(request);
    const body = InviteFriendsSchema.parse(await readJson(request));
    const settings = await setInviteFriends(getDb().db, { settings: body, actorUserId: user.id });
    return json(200, settings);
  });
}
