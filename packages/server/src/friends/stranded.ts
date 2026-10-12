import { friendInvites, users, type Db } from '@hub/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { HubMetrics } from '../metrics';
import { offboardUser } from '../offboarding';

/**
 * The safety net under offboarding's own cascade (D-117): offboards every active friend who no longer
 * has a way in, with reason 'inviter_left' when their inviter is no longer an active member and
 * 'invite_removed' when their invite is gone. Run by the hourly expire-grace job, as the system.
 * Returns how many it offboarded.
 */
export async function offboardStrandedFriends(
  db: Db,
  opts: { graceDays: number; now?: Date; metrics?: HubMetrics },
): Promise<number> {
  const rows = await db
    .select({
      id: users.id,
      // Written out: drizzle leaves column references in select fields unqualified.
      hasInvite: sql<boolean>`EXISTS (SELECT 1 FROM friend_invites fi WHERE fi.user_id = "users"."id")`,
    })
    .from(users)
    .where(
      and(
        eq(users.status, 'active'),
        eq(users.access, 'friend'),
        sql`NOT EXISTS (
          SELECT 1 FROM ${friendInvites} i JOIN ${users} inviter ON inviter.id = i.invited_by_user_id
          WHERE i.user_id = ${users.id} AND inviter.status = 'active' AND inviter.access = 'member'
        )`,
      ),
    )
    .orderBy(asc(users.id));
  for (const row of rows) {
    await offboardUser(db, {
      userId: row.id,
      reason: row.hasInvite ? 'inviter_left' : 'invite_removed',
      graceDays: opts.graceDays,
      now: opts.now,
      metrics: opts.metrics,
    });
  }
  return rows.length;
}
