/**
 * GET /api/app/members → 200 `{ members: [{ userId, name, image }] }`: the guild's active members by
 * name (@hub/server listActiveMembers), for the sharing panel's grant picker. Members in their grace
 * period are left out (a grant to them does nothing). Session auth (401).
 */
import { getDb } from '@hub/db';
import { listActiveMembers } from '@hub/server';
import { handleApi, json } from '@/lib/http';
import { requireApiUser } from '@/lib/session';

export async function GET(request: Request): Promise<Response> {
  return handleApi(async () => {
    await requireApiUser(request);
    const members = await listActiveMembers(getDb().db);
    return json(200, { members });
  });
}
