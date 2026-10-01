import {
  accountLinks,
  apiKeys,
  devices,
  osrsAccounts,
  session,
  users,
  type Db,
  type DbOrTx,
  type OffboardReason,
  type Tx,
  type UserStatus,
} from '@hub/db';
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { SYSTEM_ACTOR, audit } from '../audit';
import { getMetrics, type HubMetrics } from '../metrics';
import {
  auditTransfer,
  findSuccessor,
  lockAccounts,
  setOwner,
  takeOverFromOwnerInGrace,
  type AuditActor,
} from './accounts';

const DAY_MS = 86_400_000;
/** Offboarding waits for ingest's per-account locks; ingest holds them for at most a few seconds. */
const LOCK_TIMEOUT = '10s';

export interface OffboardResult {
  /** Accounts whose ownership moved to the longest-linked active contributor. */
  transferred: number[];
  /** Accounts hidden because no active contributor remained. */
  hidden: number[];
  revokedDevices: number;
  deletedSessions: number;
}

/**
 * Offboards a user (handoff §14): status → grace with grace_until = now + graceDays and the reason;
 * revoke all their devices (reason 'offboarding') and API keys; delete their sessions (a rejected
 * login doesn't end existing sessions); for each account they own, transfer ownership to the active,
 * non-blocked contributor linked longest (audit entry), else hide it. Idempotent for a user already
 * in grace (keeps the earliest grace_until). All in one transaction. Once it commits, a user who was
 * active counts in hub_offboarded_users_total{reason}.
 */
export async function offboardUser(
  db: Db,
  opts: {
    userId: string;
    reason: OffboardReason;
    graceDays: number;
    now?: Date;
    actorUserId?: string | null;
    actorLabel?: string;
    metrics?: HubMetrics;
  },
): Promise<OffboardResult> {
  if (!Number.isFinite(opts.graceDays) || opts.graceDays < 0) {
    throw new RangeError('offboardUser: graceDays must be a non-negative number');
  }
  const now = opts.now ?? new Date();
  const actor = auditActor(opts);
  const { result, wasActive } = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`);
    // FOR NO KEY UPDATE: ingest's account_links inserts take FOR KEY SHARE on this row (the FK
    // check), which a plain FOR UPDATE would block.
    const [user] = await tx
      .select({
        status: users.status,
        graceUntil: users.graceUntil,
        offboardReason: users.offboardReason,
      })
      .from(users)
      .where(eq(users.id, opts.userId))
      .for('no key update');
    if (!user) {
      const result: OffboardResult = {
        transferred: [],
        hidden: [],
        revokedDevices: 0,
        deletedSessions: 0,
      };
      return { result, wasActive: false };
    }

    const next = nextGraceState(
      user,
      opts.reason,
      new Date(now.getTime() + opts.graceDays * DAY_MS),
    );
    await tx
      .update(users)
      .set({ status: 'grace', graceUntil: next.graceUntil, offboardReason: next.reason })
      .where(eq(users.id, opts.userId));
    // Lock order, as ingest takes them: the owned accounts' locks, then the device rows, and the
    // osrs_accounts writes last. A payload in flight for one of those accounts waits at its lock; a
    // payload for another account holds its device row and may need SHARE ROW EXCLUSIVE on
    // osrs_accounts for a new chunk, so writing osrs_accounts before the device rows would deadlock
    // with it (TSDB-12).
    const owned = await lockOwnedAccounts(tx, opts.userId);
    const revokedDevices = await revokeDevices(tx, opts.userId, now);
    const { transferred, hidden } = await settleOwnedAccounts(tx, opts.userId, owned, now, actor);
    const revokedApiKeys = await revokeApiKeys(tx, opts.userId, now);
    const deletedSessions = await deleteSessions(tx, opts.userId);

    if (next.changed) {
      await audit(tx, {
        ...actor,
        action: 'user.offboarded',
        targetType: 'user',
        targetId: opts.userId,
        meta: {
          reason: next.reason,
          graceUntil: next.graceUntil.toISOString(),
          transferred: transferred.length,
          hidden: hidden.length,
          revokedDevices,
          revokedApiKeys,
          deletedSessions,
        },
      });
    }
    return {
      result: { transferred, hidden, revokedDevices, deletedSessions },
      wasActive: user.status === 'active',
    };
  });
  if (wasActive) (opts.metrics ?? getMetrics()).offboardedUsers.inc({ reason: opts.reason });
  return result;
}

/**
 * Coming back within the grace period: status → active, grace_until/offboard_reason cleared, and
 * accounts become visible again: the ones this user owns that were hidden, and (D-60) those hidden
 * because their owner is in grace on which this user is a non-blocked contributor, which pass to
 * this user (audited as ownership transfers, reason 'owner_in_grace'). `unhidden` lists both.
 * Devices stay revoked; accounts transferred away at offboarding stay with their new owner. No-op
 * for an active user.
 *
 * Lock order as offboardUser's: the user's row, then the accounts' locks (ingest's, ascending),
 * then their rows; so a payload in flight for one of them finishes first, and an owner change
 * (ingest's own D-60 takeover, say) is seen before deciding.
 */
export async function restoreUser(
  db: DbOrTx,
  opts: { userId: string; actorUserId?: string | null; actorLabel?: string; now?: Date },
): Promise<{ unhidden: number[] }> {
  const actor = auditActor(opts);
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    // Transaction-local: inside a caller's transaction it holds for the rest of that transaction.
    await tx.execute(sql`SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`);
    const [user] = await tx
      .select({ status: users.status, offboardReason: users.offboardReason })
      .from(users)
      .where(eq(users.id, opts.userId))
      .for('no key update');
    if (!user || user.status !== 'grace') return { unhidden: [] };

    await tx
      .update(users)
      .set({ status: 'active', graceUntil: null, offboardReason: null })
      .where(eq(users.id, opts.userId));
    const { own, adoptable } = await hiddenAccountsToRestore(tx, opts.userId);
    await lockAccounts(tx, [...own, ...adoptable]);
    const unhidden = await unhideOwnAccounts(tx, opts.userId, own);
    const taken: number[] = [];
    for (const id of adoptable) {
      if (await takeOverFromOwnerInGrace(tx, id, opts.userId, actor, now)) taken.push(id);
    }
    const ids = [...unhidden, ...taken].sort((a, b) => a - b);
    await audit(tx, {
      ...actor,
      action: 'user.restored',
      targetType: 'user',
      targetId: opts.userId,
      meta: {
        previousReason: user.offboardReason,
        unhidden: ids.length,
        transferred: taken.length,
      },
    });
    return { unhidden: ids };
  });
}

/**
 * The hidden accounts a returning user may bring back, ascending: `own` (they own it) and
 * `adoptable` (D-60: someone else in grace owns it, and the user has a non-blocked link). Read before
 * the account locks are taken; each is checked again under its lock.
 */
async function hiddenAccountsToRestore(
  tx: Tx,
  userId: string,
): Promise<{ own: number[]; adoptable: number[] }> {
  const rows = await tx
    .select({ id: osrsAccounts.id, ownerUserId: osrsAccounts.ownerUserId })
    .from(osrsAccounts)
    .innerJoin(users, eq(users.id, osrsAccounts.ownerUserId))
    .leftJoin(
      accountLinks,
      and(
        eq(accountLinks.accountId, osrsAccounts.id),
        eq(accountLinks.userId, userId),
        eq(accountLinks.blocked, false),
      ),
    )
    .where(
      and(
        eq(osrsAccounts.status, 'hidden'),
        or(
          eq(osrsAccounts.ownerUserId, userId),
          and(eq(users.status, 'grace'), isNotNull(accountLinks.userId)),
        ),
      ),
    )
    .orderBy(asc(osrsAccounts.id));
  return {
    own: rows.filter((r) => r.ownerUserId === userId).map((r) => r.id),
    adoptable: rows.filter((r) => r.ownerUserId !== userId).map((r) => r.id),
  };
}

/** Un-hides the given accounts that (still) belong to the user; returns those it changed. */
async function unhideOwnAccounts(
  tx: Tx,
  userId: string,
  accountIds: readonly number[],
): Promise<number[]> {
  if (accountIds.length === 0) return [];
  const rows = await tx
    .update(osrsAccounts)
    .set({ status: 'active', hiddenAt: null })
    .where(
      and(
        inArray(osrsAccounts.id, [...accountIds]),
        eq(osrsAccounts.ownerUserId, userId),
        eq(osrsAccounts.status, 'hidden'),
      ),
    )
    .returning({ id: osrsAccounts.id });
  return rows.map((r) => r.id);
}

/** Attribution: an explicit label wins; the system otherwise, unless a user acted. */
function auditActor(opts: { actorUserId?: string | null; actorLabel?: string }): AuditActor {
  const actorUserId = opts.actorUserId ?? null;
  const fallback = actorUserId ? null : SYSTEM_ACTOR.actorLabel;
  return { actorUserId, actorLabel: opts.actorLabel ?? fallback };
}

interface GraceState {
  status: UserStatus;
  graceUntil: Date | null;
  offboardReason: OffboardReason | null;
}

/**
 * The grace state after offboarding again. A user already in grace keeps the earliest grace_until.
 * An admin decision sticks (D-35: logging in doesn't undo it), so 'admin' replaces a membership or
 * self-delete reason and nothing replaces 'admin'; otherwise the first reason stays. `changed` says
 * whether anything worth an audit entry happened.
 */
export function nextGraceState(
  user: GraceState,
  reason: OffboardReason,
  proposedUntil: Date,
): { graceUntil: Date; reason: OffboardReason; changed: boolean } {
  if (user.status !== 'grace' || !user.graceUntil) {
    return { graceUntil: proposedUntil, reason, changed: true };
  }
  const graceUntil = user.graceUntil <= proposedUntil ? user.graceUntil : proposedUntil;
  const nextReason =
    reason === 'admin' || user.offboardReason === null ? reason : user.offboardReason;
  return {
    graceUntil,
    reason: nextReason,
    changed:
      nextReason !== user.offboardReason || graceUntil.getTime() !== user.graceUntil.getTime(),
  };
}

/** The ids of the accounts the user owns, each locked with ingest's per-account lock (ascending). */
async function lockOwnedAccounts(tx: Tx, userId: string): Promise<number[]> {
  const rows = await tx
    .select({ id: osrsAccounts.id })
    .from(osrsAccounts)
    .where(eq(osrsAccounts.ownerUserId, userId))
    .orderBy(asc(osrsAccounts.id));
  const ids = rows.map((r) => r.id);
  await lockAccounts(tx, ids);
  return ids;
}

/**
 * Handoff §14.3 for every account the user owns: transfer to the active, non-blocked contributor
 * linked longest, else hide. Each account is re-read under ingest's account lock and its row lock,
 * so an owner change that landed meanwhile (a manual transfer) is respected.
 */
async function settleOwnedAccounts(
  tx: Tx,
  userId: string,
  owned: readonly number[],
  now: Date,
  actor: AuditActor,
): Promise<{ transferred: number[]; hidden: number[] }> {
  const transferred: number[] = [];
  const hidden: number[] = [];
  for (const id of owned) {
    const [account] = await tx
      .select({
        publicId: osrsAccounts.publicId,
        ownerUserId: osrsAccounts.ownerUserId,
        status: osrsAccounts.status,
      })
      .from(osrsAccounts)
      .where(eq(osrsAccounts.id, id))
      .for('update');
    if (!account || account.ownerUserId !== userId) continue;
    const successor = await findSuccessor(tx, id, { exclude: [userId] });
    if (successor) {
      await setOwner(tx, id, successor, now);
      await auditTransfer(tx, actor, account, {
        from: userId,
        to: successor.userId,
        reason: 'offboarding',
      });
      transferred.push(id);
    } else if (account.status !== 'hidden') {
      await tx
        .update(osrsAccounts)
        .set({ status: 'hidden', hiddenAt: now })
        .where(eq(osrsAccounts.id, id));
      hidden.push(id);
    }
  }
  return { transferred, hidden };
}

/** Ingest answers a revoked device with 401 and the plugin disables the connection (handoff §14.2). */
async function revokeDevices(tx: Tx, userId: string, now: Date): Promise<number> {
  const res = await tx
    .update(devices)
    .set({ revokedAt: now, revokedReason: 'offboarding' })
    .where(and(eq(devices.userId, userId), isNull(devices.revokedAt)));
  return res.rowCount ?? 0;
}

async function revokeApiKeys(tx: Tx, userId: string, now: Date): Promise<number> {
  const res = await tx
    .update(apiKeys)
    .set({ revokedAt: now })
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)));
  return res.rowCount ?? 0;
}

/**
 * Signs the user out everywhere. See AUTH-8: this takes effect at once only because Better Auth's
 * session cookieCache is off, so every request reads the session row.
 */
async function deleteSessions(tx: Tx, userId: string): Promise<number> {
  const res = await tx.delete(session).where(eq(session.userId, userId));
  return res.rowCount ?? 0;
}
