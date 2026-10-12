/**
 * What a successful Discord sign-in does to the user's row (handoff §5, §14.4; D-35). Called by the
 * web app's Better Auth `session.create.before` hook, after the guild gate passed.
 */
import { friendInvites, users, type Db, type UserAccess } from '@hub/db';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { audit } from '../audit';
import { restoreUser } from './offboard';

/** The member data the guild gate read from Discord at sign-in. */
export interface SignInSnapshot {
  name: string;
  image: string;
  nickname: string | null;
  roles: string[];
  isAdmin: boolean;
  /**
   * How the gate let the user in (D-117): as a `member` of the guild (the default), or as a `friend`
   * on the invite `inviteId`.
   */
  access?: UserAccess;
  inviteId?: string | null;
}

/**
 * Refreshes the user's member data from the sign-in snapshot (name, avatar, nickname, roles, admin
 * flag; `lastVerifiedAt` now, `verifyFailures` 0), and brings a user in grace back (restoreUser,
 * audited with actor label `login`: status active, hidden accounts visible again, D-60).
 *
 * `'revoked'` and nothing written when an admin offboarded the user: logging in never undoes that,
 * only membership reasons are (D-35). The caller refuses the session then.
 *
 * Invite a friend (D-117): a friend's first sign-in binds their invite to them, so it follows their
 * Discord account from then on. A friend who signs in as a member (they joined the guild) is a
 * member from now on: their invite is deleted, which gives their inviter the place back, and audited
 * as 'friend.became_member'.
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
      access: snapshot.access ?? 'member',
    })
    .where(eq(users.id, userId));
  if (snapshot.access === 'friend' && snapshot.inviteId) {
    await db
      .update(friendInvites)
      .set({ userId, joinedAt: sql`COALESCE(${friendInvites.joinedAt}, ${now})` })
      .where(
        and(
          eq(friendInvites.id, snapshot.inviteId),
          or(isNull(friendInvites.userId), eq(friendInvites.userId, userId)),
        ),
      );
  } else if (snapshot.access !== 'friend') {
    const promoted = await db
      .delete(friendInvites)
      .where(eq(friendInvites.userId, userId))
      .returning({ id: friendInvites.id, username: friendInvites.username });
    for (const invite of promoted) {
      await audit(db, {
        actorLabel: 'login',
        action: 'friend.became_member',
        targetType: 'friend_invite',
        targetId: invite.id,
        meta: { username: invite.username, userId },
      });
    }
  }
  if (current?.status === 'grace') {
    await restoreUser(db, { userId, actorLabel: 'login', now });
  }
  return 'ok';
}
