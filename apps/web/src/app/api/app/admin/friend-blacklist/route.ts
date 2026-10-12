/**
 * POST /api/app/admin/friend-blacklist `{ username }` → 200 `{ username, removedInvite, offboarded }`:
 * an admin blacklists a Discord username (D-117). Nobody can invite it any more; the invite made for
 * it is removed, and a friend who signed in on it is barred by their Discord account too and
 * offboarded with reason 'blacklisted'. 400 for something that can't be a Discord username. Session
 * auth (401), admins only (403), an Origin check (403 `bad_origin`, D-36), a strict body (400).
 * Audited as 'friend.blacklisted'.
 */
import { getConfig } from '@hub/core';
import { getDb } from '@hub/db';
import { blacklistFriend } from '@hub/server';
import { z } from 'zod';
import { assertSameOrigin, handleApi, json, readJson } from '@/lib/http';
import { requireApiAdmin } from '../guard';

const BlacklistSchema = z.strictObject({ username: z.string().max(64) });

export async function POST(request: Request): Promise<Response> {
  return handleApi(async () => {
    assertSameOrigin(request);
    const { viewer } = await requireApiAdmin(request);
    const { username } = BlacklistSchema.parse(await readJson(request));
    const result = await blacklistFriend(getDb().db, {
      actor: viewer,
      username,
      graceDays: getConfig().offboardGraceDays,
    });
    return json(200, result);
  });
}
