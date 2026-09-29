/**
 * The admin API's gate (handoff §12 Admin): the signed-in, active user (401 otherwise, via
 * requireApiUser) who is an admin, fresh from the database (loadViewer), else ApiError 403
 * `forbidden`. The admin pages answer 404 to non-admins instead (requireAdmin); an API caller already
 * knows the route exists. The @hub/server admin actions check the actor again.
 */
import { ApiError } from '@/lib/http';
import { requireApiUser, type CurrentUser } from '@/lib/session';

export async function requireApiAdmin(request: Request): Promise<CurrentUser> {
  const current = await requireApiUser(request);
  if (!current.viewer.isAdmin) {
    throw new ApiError(403, 'forbidden', 'Only admins can do this.');
  }
  return current;
}
