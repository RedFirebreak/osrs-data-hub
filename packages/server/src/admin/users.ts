/**
 * Admin → Users (handoff §12): every user with status and grace, and the admin's offboard/restore.
 */
import type { Viewer } from '@hub/core';
import { users, type Db, type OffboardReason, type UserStatus } from '@hub/db';
import { asc, eq, sql } from 'drizzle-orm';
import { offboardUser, restoreUser, type OffboardResult } from '../offboarding';
import { AdminError } from './errors';

export interface AdminUserRow {
  id: string;
  name: string;
  image: string | null;
  discordId: string | null;
  isAdmin: boolean;
  status: UserStatus;
  graceUntil: Date | null;
  offboardReason: OffboardReason | null;
  lastVerifiedAt: Date | null;
  /** Consecutive failed Discord re-verifications (errors, not "not a member"). */
  verifyFailures: number;
  createdAt: Date;
  /** Devices that aren't revoked. */
  devices: number;
  /** Linked OSRS accounts (owner or non-blocked contributor). */
  accounts: number;
}

/**
 * Every user for the admin page, by name (case-insensitive), with their active device and linked
 * account counts. Users in grace are included; the page shows grace_until and the reason.
 */
export async function listUsers(db: Db): Promise<AdminUserRow[]> {
  return db
    .select({
      id: users.id,
      name: users.name,
      image: users.image,
      discordId: users.discordId,
      isAdmin: users.isAdmin,
      status: users.status,
      graceUntil: users.graceUntil,
      offboardReason: users.offboardReason,
      lastVerifiedAt: users.lastVerifiedAt,
      verifyFailures: users.verifyFailures,
      createdAt: users.createdAt,
      // Written out: drizzle leaves column references in select fields unqualified.
      devices: sql<number>`(SELECT count(*) FROM devices d WHERE d.user_id = "users"."id" AND d.revoked_at IS NULL)::int`,
      accounts: sql<number>`(SELECT count(*) FROM account_links l WHERE l.user_id = "users"."id" AND NOT l.blocked)::int`,
    })
    .from(users)
    .orderBy(sql`lower(${users.name})`, asc(users.id));
}

/**
 * An admin offboards a user (handoff §14, reason 'admin'): the same pipeline as a departure, but
 * logging in again doesn't undo it (D-35). Refused for a non-admin actor (forbidden), an unknown user
 * (not_found) and the actor themselves (invalid: an admin can't lock themselves out). Offboarding a
 * user already in grace keeps the earlier grace_until and makes the reason 'admin'.
 */
export async function adminOffboardUser(
  db: Db,
  opts: { actor: Viewer; userId: string; graceDays: number; now?: Date },
): Promise<OffboardResult> {
  assertAdmin(opts.actor);
  if (opts.userId === opts.actor.userId) {
    throw new AdminError('invalid', "you can't offboard yourself");
  }
  await assertUserExists(db, opts.userId);
  return offboardUser(db, {
    userId: opts.userId,
    reason: 'admin',
    graceDays: opts.graceDays,
    now: opts.now,
    actorUserId: opts.actor.userId,
  });
}

/**
 * An admin brings a user in grace back (whatever the reason): active again and their hidden accounts
 * visible; devices stay revoked. A no-op for an active user. Re-verification offboards them again
 * if Discord still says they left.
 */
export async function adminRestoreUser(
  db: Db,
  opts: { actor: Viewer; userId: string },
): Promise<{ unhidden: number[] }> {
  assertAdmin(opts.actor);
  await assertUserExists(db, opts.userId);
  return restoreUser(db, { userId: opts.userId, actorUserId: opts.actor.userId });
}

/** Only an active admin may act (the route checks too; this is the second lock). */
function assertAdmin(actor: Viewer): void {
  if (actor.isAdmin !== true || actor.status !== 'active') {
    throw new AdminError('forbidden', 'admins only');
  }
}

async function assertUserExists(db: Db, userId: string): Promise<void> {
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > 255) {
    throw new AdminError('not_found', 'user not found');
  }
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  if (!row) throw new AdminError('not_found', 'user not found');
}
