/**
 * Invite a friend (D-117): the signed-in member's friends.
 *
 * GET → 200 `{ access, invitedBy, enabled, maxPerMember, friends }`: whether the user may invite
 * (`access` `member`) or was invited (`friend`, with `invitedBy`), the admin's settings, and the
 * user's invites. Session auth (401).
 *
 * POST `{ username }` → 201 `{ friend }`: invites a Discord username. The friend signs in with Discord
 * and gets in on the invite although they are not in the guild. 400 for something that can't be a
 * Discord username, 403 for an invited friend (no friends of friends) or while an admin has turned
 * invites off, 409 `conflict` for a name already invited or blacklisted, 409 `limit` at the admin's
 * number of friends per member. Session auth (401), an Origin check (403 `bad_origin`, D-36), a
 * strict body (400). Audited as 'friend.invited'.
 */
import { getDb } from '@hub/db';
import { getMyFriends, inviteFriend } from '@hub/server';
import { z } from 'zod';
import { assertSameOrigin, handleApi, json, readJson } from '@/lib/http';
import { requireApiUser } from '@/lib/session';
import { friendJson } from './wire';

const InviteSchema = z.strictObject({ username: z.string().max(64) });

export async function GET(request: Request): Promise<Response> {
  return handleApi(async () => {
    const { user } = await requireApiUser(request);
    const view = await getMyFriends(getDb().db, user.id);
    return json(200, { ...view, friends: view.friends.map(friendJson) });
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { viewer } = await requireApiUser(request);
    const { username } = InviteSchema.parse(await readJson(request));
    const friend = await inviteFriend(getDb().db, { actor: viewer, username });
    return json(201, { friend: friendJson(friend) });
  });
}
