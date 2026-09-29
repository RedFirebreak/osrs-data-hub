/**
 * Sharing and ownership changes (handoff §10): audiences, grants, ownership transfer and claim,
 * blocking and removing contributors. Each change is one transaction that locks the account row
 * first, so concurrent changes (and ingest's first-reporter claim, which updates the same row)
 * serialize; each change is audited with the actor and the account. A request that changes nothing
 * (same audience, existing grant, already blocked…) succeeds without an audit entry.
 *
 * Permission: resolveAccess(...).canManage (the owner, or an admin override); claimOwnership has its
 * own rule. Refusals throw SharingError.
 */
import {
  AUDIENCES,
  effectiveAudience,
  isCategory,
  resolveAccess,
  type AccountAccess,
  type Audience,
  type Category,
  type ResolvedAccess,
  type Viewer,
} from '@hub/core';
import {
  accountLinks,
  accountShareGrants,
  accountSharing,
  osrsAccounts,
  users,
  type AccountStatus,
  type Db,
  type Tx,
} from '@hub/db';
import { and, eq, sql } from 'drizzle-orm';
import { loadAccountAccess } from '../accounts/access';
import { audit } from '../audit';
import { SharingError } from './errors';

/** Bounds the wait for the account row (an ingest transaction holds it for at most seconds). */
const LOCK_TIMEOUT = '5s';

interface Locked {
  account: { id: number; publicId: string; ownerUserId: string | null; status: AccountStatus };
  raw: AccountAccess;
  access: ResolvedAccess;
}

/** Sets who may see `category` of the account (private, guild, or selected people). */
export async function setAudience(
  db: Db,
  actor: Viewer,
  publicId: string,
  category: Category,
  audience: Audience,
): Promise<void> {
  assertCategory(category);
  if (!(AUDIENCES as readonly unknown[]).includes(audience)) {
    throw new SharingError('invalid', 'unknown audience');
  }
  await managed(db, actor, publicId, async (tx, { account, raw, access }) => {
    if (raw.sharing[category] === audience) return;
    await tx
      .insert(accountSharing)
      .values({ accountId: account.id, category, audience })
      .onConflictDoUpdate({
        target: [accountSharing.accountId, accountSharing.category],
        set: { audience, updatedAt: sql`now()` },
      });
    await auditChange(tx, actor, access, account.publicId, 'sharing.audience_changed', {
      category,
      from: effectiveAudience(raw, category),
      to: audience,
    });
  });
}

/**
 * Grants `category` to one user (effective while the category's audience is 'selected'). The grantee
 * must be an active member. Granting twice is a no-op.
 */
export async function addGrant(
  db: Db,
  actor: Viewer,
  publicId: string,
  category: Category,
  granteeUserId: string,
): Promise<void> {
  assertCategory(category);
  assertUserId(granteeUserId);
  await managed(db, actor, publicId, async (tx, { account, access }) => {
    if (!(await isActiveUser(tx, granteeUserId))) {
      throw new SharingError('invalid', 'the grantee must be an active member');
    }
    const inserted = await tx
      .insert(accountShareGrants)
      .values({ accountId: account.id, category, granteeUserId })
      .onConflictDoNothing()
      .returning({ userId: accountShareGrants.granteeUserId });
    if (inserted.length === 0) return;
    await auditChange(tx, actor, access, account.publicId, 'sharing.grant_added', {
      category,
      granteeUserId,
    });
  });
}

/** Removes a grant; a grant that doesn't exist is a no-op. Works for grantees in grace too. */
export async function removeGrant(
  db: Db,
  actor: Viewer,
  publicId: string,
  category: Category,
  granteeUserId: string,
): Promise<void> {
  assertCategory(category);
  assertUserId(granteeUserId);
  await managed(db, actor, publicId, async (tx, { account, access }) => {
    const deleted = await tx
      .delete(accountShareGrants)
      .where(
        and(
          eq(accountShareGrants.accountId, account.id),
          eq(accountShareGrants.category, category),
          eq(accountShareGrants.granteeUserId, granteeUserId),
        ),
      )
      .returning({ userId: accountShareGrants.granteeUserId });
    if (deleted.length === 0) return;
    await auditChange(tx, actor, access, account.publicId, 'sharing.grant_removed', {
      category,
      granteeUserId,
    });
  });
}

/**
 * Makes an active, non-blocked contributor the owner (handoff §10). The previous owner stays a
 * contributor, and account_links roles are updated in the same transaction. A hidden account (owner
 * offboarded without a transfer) becomes visible again: the reason it was hidden no longer holds.
 */
export async function transferOwnership(
  db: Db,
  actor: Viewer,
  publicId: string,
  newOwnerUserId: string,
): Promise<void> {
  assertUserId(newOwnerUserId);
  await managed(db, actor, publicId, async (tx, { account, raw, access }) => {
    if (newOwnerUserId === account.ownerUserId) {
      throw new SharingError('invalid', 'this user already owns the account');
    }
    const link = raw.links.find((l) => l.userId === newOwnerUserId);
    if (!link || link.blocked !== false || !(await isActiveUser(tx, newOwnerUserId))) {
      throw new SharingError('invalid', 'the new owner must be an active, non-blocked contributor');
    }
    const unhidden = await setOwner(tx, account, newOwnerUserId);
    await auditChange(tx, actor, access, account.publicId, 'account.ownership_transferred', {
      from: account.ownerUserId,
      to: newOwnerUserId,
      reason: 'manual',
      unhidden,
    });
  });
}

/**
 * Claims an account that has no owner (its owner was deleted): only an active, non-blocked
 * contributor may, and only while owner_user_id is null ("ownership is claimed explicitly", handoff
 * §10). Checked under the row lock, so two contributors can't both claim.
 */
export async function claimOwnership(db: Db, actor: Viewer, publicId: string): Promise<void> {
  await inTransaction(db, async (tx) => {
    const { account, access } = await lockAccount(tx, actor, publicId);
    if (access.relation !== 'contributor' && access.relation !== 'owner') {
      throw new SharingError('forbidden', 'only a contributor can claim this account');
    }
    if (account.ownerUserId !== null) {
      throw new SharingError('invalid', 'the account already has an owner');
    }
    const unhidden = await setOwner(tx, account, actor.userId);
    await auditChange(tx, actor, access, account.publicId, 'account.ownership_claimed', {
      unhidden,
    });
  });
}

/**
 * Blocks or unblocks a contributor. The owner can't be blocked. A blocked contributor's devices keep
 * sending, but ingest stores nothing from them (handoff §7.1.7) and they lose the contributor view.
 */
export async function setContributorBlocked(
  db: Db,
  actor: Viewer,
  publicId: string,
  userId: string,
  blocked: boolean,
): Promise<void> {
  assertUserId(userId);
  await managed(db, actor, publicId, async (tx, { account, raw, access }) => {
    const link = contributorLink(account, raw, userId, 'blocked');
    if (link.blocked === blocked) return;
    await tx
      .update(accountLinks)
      .set({ blocked, blockedAt: blocked ? sql`now()` : null })
      .where(and(eq(accountLinks.accountId, account.id), eq(accountLinks.userId, userId)));
    const action = blocked ? 'account.contributor_blocked' : 'account.contributor_unblocked';
    await auditChange(tx, actor, access, account.publicId, action, { userId });
  });
}

/**
 * Removes a contributor's link. Their devices' next payload links them again (ingest), so this is for
 * someone who stopped playing the account; blocking is how to keep someone out. The owner can't be
 * removed, and neither can a blocked contributor: deleting the link would delete the block with it.
 */
export async function removeContributor(
  db: Db,
  actor: Viewer,
  publicId: string,
  userId: string,
): Promise<void> {
  assertUserId(userId);
  await managed(db, actor, publicId, async (tx, { account, raw, access }) => {
    const link = contributorLink(account, raw, userId, 'removed');
    if (link.blocked) {
      throw new SharingError('invalid', 'unblock this contributor before removing them');
    }
    await tx
      .delete(accountLinks)
      .where(and(eq(accountLinks.accountId, account.id), eq(accountLinks.userId, userId)));
    await auditChange(tx, actor, access, account.publicId, 'account.contributor_removed', {
      userId,
    });
  });
}

/** Runs `fn` in a transaction on the locked account after checking canManage. */
async function managed(
  db: Db,
  actor: Viewer,
  publicId: string,
  fn: (tx: Tx, locked: Locked) => Promise<void>,
): Promise<void> {
  await inTransaction(db, async (tx) => {
    const locked = await lockAccount(tx, actor, publicId);
    if (!locked.access.canManage) {
      throw new SharingError('forbidden', 'only the owner or an admin can change this');
    }
    await fn(tx, locked);
  });
}

async function inTransaction(db: Db, fn: (tx: Tx) => Promise<void>): Promise<void> {
  await db.transaction(async (tx) => {
    // set_config: SET LOCAL takes no bind parameters (DB-11).
    await tx.execute(sql`SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`);
    await fn(tx);
  });
}

/**
 * Locks the account row (FOR UPDATE) and resolves the actor's access under the lock. Ingest locks the
 * same row first too (its account upsert), so the two never deadlock. An account the actor may not
 * see is reported as not found.
 */
async function lockAccount(tx: Tx, actor: Viewer, publicId: string): Promise<Locked> {
  if (typeof publicId !== 'string' || publicId.length === 0 || publicId.length > 64) {
    throw new SharingError('not_found', 'account not found');
  }
  const [account] = await tx
    .select({
      id: osrsAccounts.id,
      publicId: osrsAccounts.publicId,
      ownerUserId: osrsAccounts.ownerUserId,
      status: osrsAccounts.status,
    })
    .from(osrsAccounts)
    .where(eq(osrsAccounts.publicId, publicId))
    .for('update');
  const raw = account ? (await loadAccountAccess(tx, [account.id])).get(account.id) : undefined;
  const access = raw ? resolveAccess(actor, raw) : null;
  if (!account || !raw || !access?.visible) {
    throw new SharingError('not_found', 'account not found');
  }
  return { account, raw, access };
}

/** Sets owner_user_id, un-hides the account, and aligns every link's role. Returns whether it was hidden. */
async function setOwner(tx: Tx, account: Locked['account'], userId: string): Promise<boolean> {
  await tx
    .update(osrsAccounts)
    .set({ ownerUserId: userId, status: 'active', hiddenAt: null })
    .where(eq(osrsAccounts.id, account.id));
  await tx
    .update(accountLinks)
    .set({
      role: sql`CASE WHEN ${accountLinks.userId} = ${userId} THEN 'owner' ELSE 'contributor' END`,
    })
    .where(eq(accountLinks.accountId, account.id));
  return account.status === 'hidden';
}

/** The target's link; the owner and users without a link are refused. */
function contributorLink(
  account: Locked['account'],
  raw: AccountAccess,
  userId: string,
  verb: 'blocked' | 'removed',
): AccountAccess['links'][number] {
  if (userId === account.ownerUserId) {
    throw new SharingError('invalid', `the owner can't be ${verb}`);
  }
  const link = raw.links.find((l) => l.userId === userId);
  if (!link) throw new SharingError('invalid', 'this user is not a contributor');
  return link;
}

async function isActiveUser(tx: Tx, userId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.status, 'active')));
  return row !== undefined;
}

async function auditChange(
  tx: Tx,
  actor: Viewer,
  access: ResolvedAccess,
  publicId: string,
  action: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await audit(tx, {
    actorUserId: actor.userId,
    action,
    targetType: 'osrs_account',
    targetId: publicId,
    // An admin acting on an account they don't own (handoff §10 "admins can override").
    meta: { ...meta, asAdmin: access.relation !== 'owner' && actor.isAdmin === true },
  });
}

function assertCategory(category: unknown): asserts category is Category {
  if (!isCategory(category)) throw new SharingError('invalid', 'unknown category');
}

function assertUserId(userId: unknown): asserts userId is string {
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > 255) {
    throw new SharingError('invalid', 'invalid user id');
  }
}
