/**
 * GET /api/app/members → 200 `{ members: [{ userId, name, image }] }`: the guild's active members by
 * name (@hub/server listActiveMembers), for the sharing panel's grant picker. Members in their grace
 * period are left out (a grant to them does nothing). Session auth (401).
 *
 * Only for viewers who can manage the sharing of at least one account (D-80): `access.canManage` from
 * the shared loaders, so an account's owner, or an admin through the admin override, exactly as the
 * sharing panel decides where to show the picker. Everyone else gets 403 `forbidden`: the member
 * directory is for choosing whom to share with, not for browsing.
 */
import { getDb } from '@hub/db';
import { listActiveMembers, loadVisibleAccounts } from '@hub/server';
import { ApiError, handleApi, json } from '@/lib/http';
import { requireApiUser } from '@/lib/session';

export async function GET(request: Request): Promise<Response> {
  return handleApi(async () => {
    const { viewer } = await requireApiUser(request);
    const { db } = getDb();
    const accounts = await loadVisibleAccounts(db, viewer);
    if (!accounts.some((entry) => entry.access.canManage)) {
      throw new ApiError(
        403,
        'forbidden',
        "Only an account's owner or an admin can add people to its sharing.",
      );
    }
    const members = await listActiveMembers(db);
    return json(200, { members });
  });
}
