/**
 * "Delete my data" in Settings (handoff §14, D-78): the offboarding pipeline, started by the user on
 * themself, with a fixed 7-day undo window instead of OFFBOARD_GRACE_DAYS. Signing in again within
 * those days is the undo (recordSignIn → restoreUser, as for membership reasons, D-35); after them the
 * hourly grace expiry hard-deletes the user and every account left without an active contributor.
 */
import { users, type Db } from '@hub/db';
import { eq } from 'drizzle-orm';
import { offboardUser } from './offboard';

/** Days between "Delete my data" and the hard delete; signing in before then cancels it (D-78). */
export const SELF_DELETE_UNDO_DAYS = 7;

/** The word the user types to confirm (compared trimmed and case-insensitively). */
export const SELF_DELETE_CONFIRMATION = 'delete';

export type SelfDeleteErrorCode = 'invalid';

/**
 * A refused "Delete my data". Routes map the code to a status: invalid → 400 (the confirmation word
 * is missing or wrong, or the user isn't active). The message is safe to show.
 */
export class SelfDeleteError extends Error {
  override name = 'SelfDeleteError';

  constructor(
    readonly code: SelfDeleteErrorCode,
    message: string = code,
  ) {
    super(message);
  }
}

export interface SelfDeleteResult {
  /** When the grace expiry deletes everything; signing in before then cancels it. */
  graceUntil: Date;
  /** Owned accounts that passed to their longest-linked active contributor. */
  transferred: number;
  /** Owned accounts hidden because no active contributor remained. */
  hidden: number;
  revokedDevices: number;
  deletedSessions: number;
}

/** Whether `confirm` is the confirmation word, ignoring surrounding space and case. */
export function isSelfDeleteConfirmation(confirm: unknown): boolean {
  return typeof confirm === 'string' && confirm.trim().toLowerCase() === SELF_DELETE_CONFIRMATION;
}

/**
 * The user deletes their own data (D-78): offboardUser with reason 'self_delete', a grace of
 * SELF_DELETE_UNDO_DAYS (whatever OFFBOARD_GRACE_DAYS says) and the user themself as the audit actor,
 * so `user.offboarded` shows who did it (actor = target, reason self_delete). Devices, API keys and
 * sessions are revoked at once; each owned account passes to its longest-linked active contributor
 * or is hidden.
 *
 * Throws SelfDeleteError 'invalid' unless `confirm` is the word "delete" (trimmed, any case) and the
 * user exists and is active. The status check is not taken under offboardUser's row lock: if the
 * worker offboards the user in between, offboardUser keeps the earlier reason and the earliest
 * grace_until (nextGraceState), so the result is the same as re-verification running a moment later.
 * `graceUntil` is read back from the user's row for that reason, never computed here.
 */
export async function deleteMyData(
  db: Db,
  opts: { userId: string; confirm: string; now?: Date },
): Promise<SelfDeleteResult> {
  if (!isSelfDeleteConfirmation(opts.confirm)) {
    throw new SelfDeleteError('invalid', `Type "${SELF_DELETE_CONFIRMATION}" to confirm.`);
  }
  const now = opts.now ?? new Date();
  const before = await userState(db, opts.userId);
  if (before?.status !== 'active') {
    throw new SelfDeleteError('invalid', 'Only an active account can delete its data.');
  }
  const result = await offboardUser(db, {
    userId: opts.userId,
    reason: 'self_delete',
    graceDays: SELF_DELETE_UNDO_DAYS,
    now,
    actorUserId: opts.userId,
  });
  const after = await userState(db, opts.userId);
  if (after?.status !== 'grace' || after.graceUntil === null) {
    // Deleted or restored between the two statements: nothing is scheduled any more.
    throw new SelfDeleteError('invalid', 'Only an active account can delete its data.');
  }
  return {
    graceUntil: after.graceUntil,
    transferred: result.transferred.length,
    hidden: result.hidden.length,
    revokedDevices: result.revokedDevices,
    deletedSessions: result.deletedSessions,
  };
}

async function userState(db: Db, userId: string) {
  const [row] = await db
    .select({ status: users.status, graceUntil: users.graceUntil })
    .from(users)
    .where(eq(users.id, userId));
  return row;
}
