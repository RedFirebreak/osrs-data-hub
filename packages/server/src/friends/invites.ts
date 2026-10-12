/**
 * Invite a friend (D-117): a member of the guild invites a friend who is not in it by their Discord
 * username, up to the admin's number per member. The friend signs in with Discord as anyone does,
 * and the guild gate lets them through on the invite (findFriendInvite). Friends can't invite.
 */
import { normalizeDiscordUsername, type UserStatus, type Viewer } from '@hub/core';
import { friendBlacklist, friendInvites, users, type Db, type UserAccess } from '@hub/db';
import { and, asc, count, eq, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { audit } from '../audit';
import { offboardUser } from '../offboarding';
import { getInviteFriends } from '../settings/invite-friends';
import { FriendError } from './errors';

/** An invite as its member sees it on their Friends page. */
export interface MyFriend {
  id: string;
  username: string;
  createdAt: Date;
  /** The friend's first sign-in; null while the invite waits. */
  joinedAt: Date | null;
  /** The hub user the invite is bound to, once they signed in. */
  friend: { name: string; image: string | null; status: UserStatus } | null;
}

/** Everything the Friends page shows a user. */
export interface MyFriendsView {
  /** Whether this user may invite at all: members may, invited friends never. */
  access: UserAccess;
  /** For a friend: the name of the member who invited them, while that invite stands. */
  invitedBy: string | null;
  enabled: boolean;
  maxPerMember: number;
  friends: MyFriend[];
}

const friendUser = alias(users, 'friend');

/** The user's own invites, oldest first, with the settings that decide whether they can add one. */
export async function getMyFriends(db: Db, userId: string): Promise<MyFriendsView> {
  const [[me], [mine], settings, friends] = await Promise.all([
    db.select({ access: users.access }).from(users).where(eq(users.id, userId)),
    db
      .select({ name: users.name })
      .from(friendInvites)
      .innerJoin(users, eq(users.id, friendInvites.invitedByUserId))
      .where(eq(friendInvites.userId, userId)),
    getInviteFriends(db),
    listInvitesBy(db, userId),
  ]);
  const access = me?.access ?? 'member';
  return {
    access,
    invitedBy: access === 'friend' ? (mine?.name ?? null) : null,
    ...settings,
    friends,
  };
}

async function listInvitesBy(db: Db, userId: string): Promise<MyFriend[]> {
  const rows = await db
    .select({
      id: friendInvites.id,
      username: friendInvites.username,
      createdAt: friendInvites.createdAt,
      joinedAt: friendInvites.joinedAt,
      friendName: friendUser.name,
      friendImage: friendUser.image,
      friendStatus: friendUser.status,
    })
    .from(friendInvites)
    .leftJoin(friendUser, eq(friendUser.id, friendInvites.userId))
    .where(eq(friendInvites.invitedByUserId, userId))
    .orderBy(asc(friendInvites.createdAt), asc(friendInvites.id));
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    createdAt: r.createdAt,
    joinedAt: r.joinedAt,
    friend:
      r.friendName !== null && r.friendStatus !== null
        ? { name: r.friendName, image: r.friendImage, status: r.friendStatus }
        : null,
  }));
}

/**
 * The actor invites `username` (normalised). Refused (FriendError) unless the actor is an active
 * member (`forbidden`: friends can't invite), the feature is on (`forbidden`), the name can be a
 * Discord username (`invalid`), nobody blacklisted it (`conflict`), nobody invited it yet
 * (`conflict`) and the actor has fewer friends than the setting allows (`limit`). The actor's row is
 * locked for the count, so two invites at once can't both take the last place. Audited as
 * 'friend.invited'.
 */
export async function inviteFriend(
  db: Db,
  opts: { actor: Viewer; username: string },
): Promise<MyFriend> {
  const username = normalizeDiscordUsername(opts.username);
  if (username === null) {
    throw new FriendError('invalid', 'That is not a Discord username.');
  }
  return db.transaction(async (tx) => {
    const [actor] = await tx
      .select({ status: users.status, access: users.access })
      .from(users)
      .where(eq(users.id, opts.actor.userId))
      .for('no key update');
    if (actor?.status !== 'active') throw new FriendError('forbidden', 'Sign in again first.');
    if (actor.access !== 'member') {
      throw new FriendError('forbidden', 'Only members of the guild can invite friends.');
    }
    const settings = await getInviteFriends(tx);
    if (!settings.enabled) {
      throw new FriendError('forbidden', 'Inviting friends is turned off on this hub.');
    }
    const [barred] = await tx
      .select({ username: friendBlacklist.username })
      .from(friendBlacklist)
      .where(eq(friendBlacklist.username, username));
    if (barred) throw new FriendError('conflict', `${username} can't be invited to this hub.`);
    const [mine] = await tx
      .select({ n: count() })
      .from(friendInvites)
      .where(eq(friendInvites.invitedByUserId, opts.actor.userId));
    if ((mine?.n ?? 0) >= settings.maxPerMember) {
      throw new FriendError(
        'limit',
        `You can have ${settings.maxPerMember} ${settings.maxPerMember === 1 ? 'friend' : 'friends'} at most. Remove one to invite someone else.`,
      );
    }
    const [row] = await tx
      .insert(friendInvites)
      .values({ username, invitedByUserId: opts.actor.userId })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new FriendError('conflict', `${username} is already invited.`);
    await audit(tx, {
      actorUserId: opts.actor.userId,
      action: 'friend.invited',
      targetType: 'friend_invite',
      targetId: row.id,
      meta: { username },
    });
    return {
      id: row.id,
      username: row.username,
      createdAt: row.createdAt,
      joinedAt: null,
      friend: null,
    };
  });
}

/**
 * The actor removes one of their own invites (another's is `not_found`). A friend who signed in on it
 * and is still in is offboarded with reason 'invite_removed', as a member who leaves the guild would
 * be. Audited as 'friend.removed'.
 */
export async function removeFriend(
  db: Db,
  opts: { actor: Viewer; inviteId: string; graceDays: number; now?: Date },
): Promise<{ offboarded: boolean }> {
  if (opts.actor.status !== 'active') throw new FriendError('forbidden', 'Sign in again first.');
  const removed = await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(friendInvites)
      .where(
        and(
          eq(friendInvites.id, opts.inviteId),
          eq(friendInvites.invitedByUserId, opts.actor.userId),
        ),
      )
      .returning();
    if (!row) return null;
    await audit(tx, {
      actorUserId: opts.actor.userId,
      action: 'friend.removed',
      targetType: 'friend_invite',
      targetId: row.id,
      meta: { username: row.username, signedIn: row.userId !== null },
    });
    return row;
  });
  if (!removed) throw new FriendError('not_found', 'That friend is not on your list.');
  return { offboarded: await offboardFriend(db, removed.userId, 'invite_removed', opts) };
}

/**
 * Offboards `userId` when they are an active friend. Shared by removal and blacklisting; a friend who
 * has since joined the guild (access 'member') is left alone.
 */
export async function offboardFriend(
  db: Db,
  userId: string | null,
  reason: 'invite_removed' | 'blacklisted',
  opts: { actor: Viewer; graceDays: number; now?: Date },
): Promise<boolean> {
  if (userId === null) return false;
  const [friend] = await db
    .select({ status: users.status, access: users.access })
    .from(users)
    .where(eq(users.id, userId));
  if (friend?.access !== 'friend' || friend.status !== 'active') return false;
  await offboardUser(db, {
    userId,
    reason,
    graceDays: opts.graceDays,
    now: opts.now,
    actorUserId: opts.actor.userId,
  });
  return true;
}

/**
 * The guild gate's second chance (D-117): the invite that lets this Discord account in, or null.
 * An invite bound to the account (by its first sign-in) counts whatever the account is called now;
 * an open one counts for exactly its username. Either needs an active inviter who is a member, and
 * neither the username nor the account may be blacklisted. Whether new invites are turned off
 * doesn't matter here: friends already invited keep their access.
 */
export async function findFriendInvite(
  db: Db,
  who: { discordId: string; username: string },
): Promise<{ id: string } | null> {
  const username = normalizeDiscordUsername(who.username) ?? who.username.toLowerCase();
  // `users` is the inviter.
  const [row] = await db
    .select({ id: friendInvites.id })
    .from(friendInvites)
    .innerJoin(users, eq(users.id, friendInvites.invitedByUserId))
    .leftJoin(friendUser, eq(friendUser.id, friendInvites.userId))
    .where(
      and(
        eq(users.status, 'active'),
        eq(users.access, 'member'),
        or(
          eq(friendUser.discordId, who.discordId),
          and(isNull(friendInvites.userId), eq(friendInvites.username, username)),
        ),
        sql`NOT EXISTS (SELECT 1 FROM ${friendBlacklist} WHERE ${friendBlacklist.username} IN (${username}, ${friendInvites.username}) OR ${friendBlacklist.discordId} = ${who.discordId})`,
      ),
    )
    // A bound invite first: an open one under the same name must not take its place.
    .orderBy(sql`${friendInvites.userId} IS NULL`, asc(friendInvites.createdAt))
    .limit(1);
  return row ? { id: row.id } : null;
}
