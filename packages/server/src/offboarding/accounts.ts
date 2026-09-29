/**
 * Account-ownership steps shared by offboarding and grace expiry (handoff §14.3, §14.5): the
 * per-account lock, choosing a successor owner, and moving ownership.
 */
import { accountLinks, osrsAccounts, users, type Tx, type UserStatus } from '@hub/db';
import { and, asc, desc, eq, gt, notInArray, or, sql } from 'drizzle-orm';
import { audit } from '../audit';
import { lockAccount } from '../ingest/store';

/** Who an offboarding step is attributed to in the audit log. */
export interface AuditActor {
  actorUserId: string | null;
  actorLabel: string | null;
}

/**
 * Takes ingest's per-account advisory lock for each account, in ascending id order. Ingest takes the
 * same lock before it writes links, devices or the account row, so an ownership change can't
 * interleave with a payload for that account, and a fixed order means two offboardings can't deadlock.
 */
export async function lockAccounts(tx: Tx, accountIds: readonly number[]): Promise<void> {
  const sorted = [...new Set(accountIds)].sort((a, b) => a - b);
  for (const id of sorted) await lockAccount(tx, id);
}

export interface Successor {
  userId: string;
  status: UserStatus;
}

/**
 * The user who would take over an account: a non-blocked link of an active user, or, with
 * `graceUntilAfter`, of a user whose grace period ends after that instant (still able to come back,
 * handoff §14.4); never one in `exclude`. Active users before users in grace, then the one linked
 * longest (earliest first_seen, user id as the tie-break so the choice is deterministic). Decided on
 * the users' current rows, so a user who came back a moment ago counts. Null when nobody qualifies.
 */
export async function findSuccessor(
  tx: Tx,
  accountId: number,
  opts: { exclude: readonly string[]; graceUntilAfter?: Date },
): Promise<Successor | null> {
  const inGraceStill = opts.graceUntilAfter
    ? and(eq(users.status, 'grace'), gt(users.graceUntil, opts.graceUntilAfter))
    : undefined;
  const [row] = await tx
    .select({ userId: accountLinks.userId, status: users.status })
    .from(accountLinks)
    .innerJoin(users, eq(users.id, accountLinks.userId))
    .where(
      and(
        eq(accountLinks.accountId, accountId),
        eq(accountLinks.blocked, false),
        or(eq(users.status, 'active'), inGraceStill),
        opts.exclude.length > 0 ? notInArray(accountLinks.userId, [...opts.exclude]) : undefined,
      ),
    )
    .orderBy(
      desc(sql`${users.status} = 'active'`),
      asc(accountLinks.firstSeen),
      asc(accountLinks.userId),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Makes `successor` the owner and aligns every link's role with it. An active owner makes the account
 * visible again; an owner who is in grace keeps (or puts) it hidden, since accounts of an owner in
 * grace are hidden (handoff §10) until restoreUser un-hides them.
 */
export async function setOwner(
  tx: Tx,
  accountId: number,
  successor: Successor,
  now: Date,
): Promise<void> {
  const visible = successor.status === 'active';
  await tx
    .update(osrsAccounts)
    .set({
      ownerUserId: successor.userId,
      status: visible ? 'active' : 'hidden',
      hiddenAt: visible
        ? null
        : sql`COALESCE(${osrsAccounts.hiddenAt}, ${now.toISOString()}::timestamptz)`,
    })
    .where(eq(osrsAccounts.id, accountId));
  await tx
    .update(accountLinks)
    .set({
      role: sql`CASE WHEN ${accountLinks.userId} = ${successor.userId} THEN 'owner' ELSE 'contributor' END`,
    })
    .where(eq(accountLinks.accountId, accountId));
}

/** Audit entry for an ownership move; `from` is null when the previous owner no longer exists. */
export async function auditTransfer(
  tx: Tx,
  actor: AuditActor,
  account: { publicId: string },
  change: { from: string | null; to: string; reason: 'offboarding' | 'grace_expired' },
): Promise<void> {
  await audit(tx, {
    ...actor,
    action: 'account.ownership_transferred',
    targetType: 'osrs_account',
    targetId: account.publicId,
    meta: change,
  });
}
