import {
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
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { audit } from '../audit';
import { auditTransfer, findSuccessor, lockAccounts, setOwner, type AuditActor } from './accounts';

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
 * in grace (keeps the earliest grace_until). All in one transaction.
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
  },
): Promise<OffboardResult> {
  if (!Number.isFinite(opts.graceDays) || opts.graceDays < 0) {
    throw new RangeError('offboardUser: graceDays must be a non-negative number');
  }
  const now = opts.now ?? new Date();
  const actor = auditActor(opts);
  return db.transaction(async (tx) => {
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
    if (!user) return { transferred: [], hidden: [], revokedDevices: 0, deletedSessions: 0 };

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
    return { transferred, hidden, revokedDevices, deletedSessions };
  });
}

/**
 * Coming back within the grace period: status → active, grace_until/offboard_reason cleared, and
 * accounts hidden because of this user become visible again. Devices stay revoked; transferred
 * accounts stay with their new owner. No-op for an active user.
 */
export async function restoreUser(
  db: DbOrTx,
  opts: { userId: string; actorUserId?: string | null; actorLabel?: string },
): Promise<{ unhidden: number[] }> {
  return db.transaction(async (tx) => {
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
    const unhidden = await tx
      .update(osrsAccounts)
      .set({ status: 'active', hiddenAt: null })
      .where(and(eq(osrsAccounts.ownerUserId, opts.userId), eq(osrsAccounts.status, 'hidden')))
      .returning({ id: osrsAccounts.id });
    const ids = unhidden.map((r) => r.id).sort((a, b) => a - b);
    await audit(tx, {
      ...auditActor(opts),
      action: 'user.restored',
      targetType: 'user',
      targetId: opts.userId,
      meta: { previousReason: user.offboardReason, unhidden: ids.length },
    });
    return { unhidden: ids };
  });
}

/** Attribution: an explicit label wins; the system otherwise, unless a user acted. */
function auditActor(opts: { actorUserId?: string | null; actorLabel?: string }): AuditActor {
  const actorUserId = opts.actorUserId ?? null;
  return { actorUserId, actorLabel: opts.actorLabel ?? (actorUserId ? null : 'system') };
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
