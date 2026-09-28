import type { OffboardReason, Db, DbOrTx } from '@hub/db';

function notImplemented(name: string): never {
  throw new Error(`not implemented: ${name}`);
}

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
  return notImplemented('offboardUser');
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
  return notImplemented('restoreUser');
}

/**
 * Hard-deletes users whose grace period expired: the user (cascades links, grants, settings,
 * sessions, devices, keys) and every account left with no active contributor, including its
 * continuous-aggregate rows (TSDB-2). Audit entries are anonymized by the FK (set null).
 */
export async function expireGracePeriods(
  db: Db,
  opts: { now?: Date },
): Promise<{ deletedUsers: number; deletedAccounts: number }> {
  return notImplemented('expireGracePeriods');
}
