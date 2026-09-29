/**
 * What a successful Discord sign-in does to the user's row (handoff §5, §14.4; D-35). Called by the
 * web app's Better Auth `session.create.before` hook, after the guild gate passed.
 */
import { users, type Db } from '@hub/db';
import { eq } from 'drizzle-orm';
import { restoreUser } from './offboard';

/** The member data the guild gate read from Discord at sign-in. */
export interface SignInSnapshot {
  name: string;
  image: string;
  nickname: string | null;
  roles: string[];
  isAdmin: boolean;
}

/**
 * Refreshes the user's member data from the sign-in snapshot (name, avatar, nickname, roles, admin
 * flag; `lastVerifiedAt` now, `verifyFailures` 0), and brings a user in grace back (restoreUser,
 * audited with actor label `login`: status active, hidden accounts visible again, D-60).
 *
 * `'revoked'` and nothing written when an admin offboarded the user: logging in never undoes that,
 * only membership reasons are (D-35). The caller refuses the session then.
 */
export async function recordSignIn(
  db: Db,
  userId: string,
  snapshot: SignInSnapshot,
  now: Date = new Date(),
): Promise<'ok' | 'revoked'> {
  const [current] = await db
    .select({ status: users.status, offboardReason: users.offboardReason })
    .from(users)
    .where(eq(users.id, userId));
  if (current?.status === 'grace' && current.offboardReason === 'admin') return 'revoked';
  await db
    .update(users)
    .set({
      name: snapshot.name,
      image: snapshot.image,
      nickname: snapshot.nickname,
      roles: snapshot.roles,
      isAdmin: snapshot.isAdmin,
      lastVerifiedAt: now,
      verifyFailures: 0,
    })
    .where(eq(users.id, userId));
  if (current?.status === 'grace') {
    await restoreUser(db, { userId, actorLabel: 'login', now });
  }
  return 'ok';
}
