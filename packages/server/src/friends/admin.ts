/**
 * Invite a friend (D-117), the admin's side: every invite with its inviter and friend, and the
 * blacklist of Discord usernames nobody may invite.
 */
import { normalizeDiscordUsername, type UserStatus, type Viewer } from '@hub/core';
import { friendBlacklist, friendInvites, users, type Db } from '@hub/db';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { assertAdmin } from '../admin/errors';
import { audit } from '../audit';
import { FriendError } from './errors';
import { offboardFriend } from './invites';

interface PersonRef {
  id: string;
  name: string;
  image: string | null;
  status: UserStatus;
}

/** One invite on Admin → Friends. */
export interface AdminFriendInvite {
  id: string;
  username: string;
  createdAt: Date;
  joinedAt: Date | null;
  invitedBy: PersonRef;
  /** The hub user the invite is bound to, once they signed in. */
  friend: PersonRef | null;
}

export interface BlacklistEntry {
  username: string;
  /** Whether the Discord account itself is barred too (the friend had signed in). */
  account: boolean;
  createdAt: Date;
  /** The admin who added it; null once that user is deleted. */
  createdBy: string | null;
}

// `users` itself is the inviter, or the admin who blacklisted.
const friend = alias(users, 'friend');

/** Every invite, newest first. */
export async function listFriendInvites(db: Db): Promise<AdminFriendInvite[]> {
  const rows = await db
    .select({
      id: friendInvites.id,
      username: friendInvites.username,
      createdAt: friendInvites.createdAt,
      joinedAt: friendInvites.joinedAt,
      inviterId: users.id,
      inviterName: users.name,
      inviterImage: users.image,
      inviterStatus: users.status,
      friendId: friend.id,
      friendName: friend.name,
      friendImage: friend.image,
      friendStatus: friend.status,
    })
    .from(friendInvites)
    .innerJoin(users, eq(users.id, friendInvites.invitedByUserId))
    .leftJoin(friend, eq(friend.id, friendInvites.userId))
    .orderBy(desc(friendInvites.createdAt), asc(friendInvites.id));
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    createdAt: r.createdAt,
    joinedAt: r.joinedAt,
    invitedBy: {
      id: r.inviterId,
      name: r.inviterName,
      image: r.inviterImage,
      status: r.inviterStatus,
    },
    friend:
      r.friendId !== null && r.friendName !== null && r.friendStatus !== null
        ? { id: r.friendId, name: r.friendName, image: r.friendImage, status: r.friendStatus }
        : null,
  }));
}

/** The blacklist, newest first. */
export async function listFriendBlacklist(db: Db): Promise<BlacklistEntry[]> {
  const rows = await db
    .select({
      username: friendBlacklist.username,
      discordId: friendBlacklist.discordId,
      createdAt: friendBlacklist.createdAt,
      createdBy: users.name,
    })
    .from(friendBlacklist)
    .leftJoin(users, eq(users.id, friendBlacklist.createdByUserId))
    .orderBy(desc(friendBlacklist.createdAt), asc(friendBlacklist.username));
  return rows.map((r) => ({
    username: r.username,
    account: r.discordId !== null,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
  }));
}

/**
 * An admin blacklists a Discord username: nobody can invite it any more, the invite made for it is
 * removed, and a friend who signed in on that invite is barred by their Discord account too (a new
 * username doesn't get them back in) and offboarded with reason 'blacklisted'. Someone who is in the
 * guild still gets in as a member: the blacklist is about invites. Blacklisting a name twice changes
 * nothing. Audited as 'friend.blacklisted'.
 */
export async function blacklistFriend(
  db: Db,
  opts: { actor: Viewer; username: string; graceDays: number; now?: Date },
): Promise<{ username: string; removedInvite: boolean; offboarded: boolean }> {
  assertAdmin(opts.actor);
  const username = normalizeDiscordUsername(opts.username);
  if (username === null) throw new FriendError('invalid', 'That is not a Discord username.');
  const removed = await db.transaction(async (tx) => {
    const [removed] = await tx
      .delete(friendInvites)
      .where(eq(friendInvites.username, username))
      .returning({ id: friendInvites.id, userId: friendInvites.userId });
    const [bound] = removed?.userId
      ? await tx
          .select({ discordId: users.discordId })
          .from(users)
          .where(eq(users.id, removed.userId))
      : [];
    const discordId = bound?.discordId ?? null;
    const [added] = await tx
      .insert(friendBlacklist)
      .values({ username, discordId, createdByUserId: opts.actor.userId })
      .onConflictDoUpdate({
        target: friendBlacklist.username,
        set: { discordId: sql`COALESCE(excluded.discord_id, ${friendBlacklist.discordId})` },
      })
      .returning({ inserted: sql<boolean>`xmax = 0` });
    if (removed || added?.inserted) {
      await audit(tx, {
        actorUserId: opts.actor.userId,
        action: 'friend.blacklisted',
        targetType: 'friend',
        targetId: username,
        meta: { username, removedInvite: removed !== undefined },
      });
    }
    return removed;
  });
  const offboarded = await offboardFriend(db, removed?.userId ?? null, 'blacklisted', opts);
  return { username, removedInvite: removed !== undefined, offboarded };
}

/**
 * An admin takes a username off the blacklist: it can be invited again. A friend offboarded for it
 * stays in grace until someone invites them again and they sign in. `not_found` when the name isn't
 * on the list. Audited as 'friend.unblacklisted'.
 */
export async function unblacklistFriend(
  db: Db,
  opts: { actor: Viewer; username: string },
): Promise<void> {
  assertAdmin(opts.actor);
  const username = opts.username.trim().toLowerCase();
  await db.transaction(async (tx) => {
    const rows = await tx
      .delete(friendBlacklist)
      .where(eq(friendBlacklist.username, username))
      .returning({ username: friendBlacklist.username });
    if (rows.length === 0) throw new FriendError('not_found', `${username} is not blacklisted.`);
    await audit(tx, {
      actorUserId: opts.actor.userId,
      action: 'friend.unblacklisted',
      targetType: 'friend',
      targetId: username,
      meta: { username },
    });
  });
}
