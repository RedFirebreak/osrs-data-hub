/**
 * Invite a friend (D-117): inviting, the guild gate's second chance, sign-in binding and promotion,
 * removal, the blacklist, and offboarding that follows the inviter.
 */
import type { Viewer } from '@hub/core';
import {
  auditLog,
  devices,
  friendBlacklist,
  friendInvites,
  hubSettings,
  session,
  users,
} from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminOffboardUser, listUsers } from '../admin';
import { offboardUser, recordSignIn, restoreUser, type SignInSnapshot } from '../offboarding';
import { seedDevice, seedSession, seedUser } from '../offboarding/test-support';
import { setInviteFriends } from '../settings/invite-friends';
import {
  blacklistFriend,
  listFriendBlacklist,
  listFriendInvites,
  unblacklistFriend,
} from './admin';
import { FriendError } from './errors';
import { findFriendInvite, getMyFriends, inviteFriend, removeFriend } from './invites';
import { offboardStrandedFriends } from './stranded';

let t: TestDatabase;
let n = 0;

beforeAll(async () => {
  t = await createTestDatabase('friends');
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  await t.db.delete(hubSettings);
});

const NOW = new Date('2026-10-12T10:00:00Z');
const GRACE_DAYS = 30;

const viewer = (userId: string, isAdmin = false): Viewer => ({
  userId,
  status: 'active',
  isAdmin,
});

/** A fresh Discord identity: a unique id and username per call. */
function discord(): { discordId: string; username: string } {
  n++;
  return { discordId: `9000000000${String(n).padStart(6, '0')}`, username: `friend.${n}` };
}

async function member(): Promise<string> {
  return seedUser(t.db, { discordId: discord().discordId });
}

const FRIEND_SNAPSHOT: Omit<SignInSnapshot, 'inviteId'> = {
  name: 'A friend',
  image: 'https://cdn.discordapp.com/embed/avatars/0.png',
  nickname: null,
  roles: [],
  isAdmin: false,
  access: 'friend',
};

/**
 * What the web app's sign-in does for a friend (lib/auth.ts): the gate's lookup, then the user's
 * row (created on a first sign-in) and recordSignIn. Null when the gate turns them away.
 */
async function signInAsFriend(who: { discordId: string; username: string }) {
  const invite = await findFriendInvite(t.db, who);
  if (!invite) return null;
  let [row] = await t.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.discordId, who.discordId));
  if (!row) {
    const id = await seedUser(t.db, { discordId: who.discordId, access: 'friend' });
    row = { id };
  }
  const result = await recordSignIn(t.db, row.id, { ...FRIEND_SNAPSHOT, inviteId: invite.id }, NOW);
  return { userId: row.id, inviteId: invite.id, result };
}

async function userRow(id: string) {
  const [row] = await t.db.select().from(users).where(eq(users.id, id));
  return row;
}

async function inviteRow(id: string) {
  const [row] = await t.db.select().from(friendInvites).where(eq(friendInvites.id, id));
  return row;
}

async function lastAudit(action: string) {
  const [row] = await t.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, action))
    .orderBy(desc(auditLog.id))
    .limit(1);
  return row;
}

async function expectFriendError(promise: Promise<unknown>, code: FriendError['code']) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(FriendError);
  expect((err as FriendError).code).toBe(code);
}

describe('inviteFriend', () => {
  it('invites a Discord username, normalised, and audits it', async () => {
    const inviter = await member();
    const invite = await inviteFriend(t.db, { actor: viewer(inviter), username: '  @Bob.Smith ' });
    expect(invite).toMatchObject({ username: 'bob.smith', joinedAt: null, friend: null });
    const view = await getMyFriends(t.db, inviter);
    expect(view).toMatchObject({ access: 'member', enabled: true, maxPerMember: 3 });
    expect(view.friends.map((f) => f.username)).toEqual(['bob.smith']);
    expect(await lastAudit('friend.invited')).toMatchObject({
      actorUserId: inviter,
      targetId: invite.id,
      meta: { username: 'bob.smith' },
    });
  });

  it('refuses what cannot be a Discord username', async () => {
    const inviter = await member();
    for (const username of ['', 'a', 'bob smith', 'bob#1234', 'two..dots', 'x'.repeat(33)]) {
      await expectFriendError(inviteFriend(t.db, { actor: viewer(inviter), username }), 'invalid');
    }
  });

  it('allows the configured number of friends per member, and no more', async () => {
    const inviter = await member();
    for (let i = 0; i < 3; i++) {
      await inviteFriend(t.db, { actor: viewer(inviter), username: discord().username });
    }
    await expectFriendError(
      inviteFriend(t.db, { actor: viewer(inviter), username: discord().username }),
      'limit',
    );
    const admin = await member();
    await setInviteFriends(t.db, {
      settings: { enabled: true, maxPerMember: 4 },
      actorUserId: admin,
    });
    await inviteFriend(t.db, { actor: viewer(inviter), username: discord().username });
  });

  it('two invites at once never take more places than there are', async () => {
    const inviter = await member();
    const admin = await member();
    await setInviteFriends(t.db, {
      settings: { enabled: true, maxPerMember: 1 },
      actorUserId: admin,
    });
    const results = await Promise.allSettled(
      [discord(), discord(), discord()].map((d) =>
        inviteFriend(t.db, { actor: viewer(inviter), username: d.username }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await getMyFriends(t.db, inviter)).friends).toHaveLength(1);
  });

  it('refuses a username somebody already invited', async () => {
    const [a, b] = [await member(), await member()];
    const { username } = discord();
    await inviteFriend(t.db, { actor: viewer(a), username });
    await expectFriendError(inviteFriend(t.db, { actor: viewer(b), username }), 'conflict');
  });

  it('refuses friends inviting friends (no friends of friends)', async () => {
    const friend = await seedUser(t.db, { discordId: discord().discordId, access: 'friend' });
    await expectFriendError(
      inviteFriend(t.db, { actor: viewer(friend), username: discord().username }),
      'forbidden',
    );
    expect((await getMyFriends(t.db, friend)).access).toBe('friend');
  });

  it('refuses new invites while an admin has turned the feature off', async () => {
    const inviter = await member();
    await setInviteFriends(t.db, {
      settings: { enabled: false, maxPerMember: 3 },
      actorUserId: inviter,
    });
    await expectFriendError(
      inviteFriend(t.db, { actor: viewer(inviter), username: discord().username }),
      'forbidden',
    );
  });

  it('refuses a blacklisted username', async () => {
    const [inviter, admin] = [await member(), await member()];
    const { username } = discord();
    await blacklistFriend(t.db, { actor: viewer(admin, true), username, graceDays: GRACE_DAYS });
    await expectFriendError(inviteFriend(t.db, { actor: viewer(inviter), username }), 'conflict');
  });
});

describe('the guild gate (findFriendInvite) and recordSignIn', () => {
  it('lets an invited username in, and binds the invite to the account at the first sign-in', async () => {
    const inviter = await member();
    const who = discord();
    expect(await findFriendInvite(t.db, who)).toBeNull();
    const invite = await inviteFriend(t.db, { actor: viewer(inviter), username: who.username });
    const signedIn = await signInAsFriend(who);
    expect(signedIn).toMatchObject({ inviteId: invite.id, result: 'ok' });
    expect(await inviteRow(invite.id)).toMatchObject({ userId: signedIn!.userId, joinedAt: NOW });
    expect(await userRow(signedIn!.userId)).toMatchObject({ access: 'friend', status: 'active' });
    const mine = await getMyFriends(t.db, inviter);
    expect(mine.friends[0]).toMatchObject({ joinedAt: NOW, friend: { status: 'active' } });
  });

  it('follows the Discord account once bound: a renamed friend still gets in, a newcomer under the old name does not', async () => {
    const inviter = await member();
    const who = discord();
    await inviteFriend(t.db, { actor: viewer(inviter), username: who.username });
    const first = await signInAsFriend(who);
    expect(await findFriendInvite(t.db, { ...who, username: 'renamed.friend' })).toEqual({
      id: first!.inviteId,
    });
    expect(
      await findFriendInvite(t.db, { discordId: discord().discordId, username: who.username }),
    ).toBeNull();
  });

  it('turns a friend away whose inviter is no longer an active member', async () => {
    const inviter = await member();
    const who = discord();
    await inviteFriend(t.db, { actor: viewer(inviter), username: who.username });
    await t.db.update(users).set({ status: 'grace' }).where(eq(users.id, inviter));
    expect(await findFriendInvite(t.db, who)).toBeNull();
    await t.db
      .update(users)
      .set({ status: 'active', access: 'friend' })
      .where(eq(users.id, inviter));
    expect(await findFriendInvite(t.db, who)).toBeNull();
  });

  it('still lets friends in while new invites are turned off', async () => {
    const inviter = await member();
    const who = discord();
    await inviteFriend(t.db, { actor: viewer(inviter), username: who.username });
    await setInviteFriends(t.db, {
      settings: { enabled: false, maxPerMember: 3 },
      actorUserId: inviter,
    });
    expect(await signInAsFriend(who)).toMatchObject({ result: 'ok' });
  });

  it('makes a friend who joined the guild a member, and gives their inviter the place back', async () => {
    const inviter = await member();
    const who = discord();
    const invite = await inviteFriend(t.db, { actor: viewer(inviter), username: who.username });
    const { userId } = (await signInAsFriend(who))!;
    // Their next sign-in passes the guild check itself: the web app gives recordSignIn a member.
    expect(
      await recordSignIn(t.db, userId, { ...FRIEND_SNAPSHOT, access: 'member', inviteId: null }),
    ).toBe('ok');
    expect(await userRow(userId)).toMatchObject({ access: 'member' });
    expect(await inviteRow(invite.id)).toBeUndefined();
    expect((await getMyFriends(t.db, inviter)).friends).toEqual([]);
    expect(await lastAudit('friend.became_member')).toMatchObject({
      targetId: invite.id,
      meta: { username: who.username, userId },
    });
  });
});

describe('removeFriend', () => {
  it('removes a waiting invite', async () => {
    const inviter = await member();
    const invite = await inviteFriend(t.db, {
      actor: viewer(inviter),
      username: discord().username,
    });
    expect(
      await removeFriend(t.db, {
        actor: viewer(inviter),
        inviteId: invite.id,
        graceDays: GRACE_DAYS,
      }),
    ).toEqual({ offboarded: false });
    expect(await inviteRow(invite.id)).toBeUndefined();
    expect(await lastAudit('friend.removed')).toMatchObject({
      actorUserId: inviter,
      meta: { signedIn: false },
    });
  });

  it("offboards a friend who signed in, as leaving the guild would (reason 'invite_removed')", async () => {
    const inviter = await member();
    const who = discord();
    const invite = await inviteFriend(t.db, { actor: viewer(inviter), username: who.username });
    const { userId } = (await signInAsFriend(who))!;
    await seedDevice(t.db, userId);
    await seedSession(t.db, userId);
    expect(
      await removeFriend(t.db, {
        actor: viewer(inviter),
        inviteId: invite.id,
        graceDays: GRACE_DAYS,
        now: NOW,
      }),
    ).toEqual({ offboarded: true });
    expect(await userRow(userId)).toMatchObject({
      status: 'grace',
      offboardReason: 'invite_removed',
    });
    expect(
      await t.db
        .select()
        .from(devices)
        .where(and(eq(devices.userId, userId), isNull(devices.revokedAt))),
    ).toEqual([]);
    expect(await t.db.select().from(session).where(eq(session.userId, userId))).toEqual([]);
    expect(await findFriendInvite(t.db, who)).toBeNull();
  });

  it("refuses another member's invite as not found", async () => {
    const [a, b] = [await member(), await member()];
    const invite = await inviteFriend(t.db, { actor: viewer(a), username: discord().username });
    await expectFriendError(
      removeFriend(t.db, { actor: viewer(b), inviteId: invite.id, graceDays: GRACE_DAYS }),
      'not_found',
    );
    expect(await inviteRow(invite.id)).toBeDefined();
  });

  it('lets a friend back in who is invited again and signs in within the grace period', async () => {
    const inviter = await member();
    const who = discord();
    const invite = await inviteFriend(t.db, { actor: viewer(inviter), username: who.username });
    const { userId } = (await signInAsFriend(who))!;
    await removeFriend(t.db, {
      actor: viewer(inviter),
      inviteId: invite.id,
      graceDays: GRACE_DAYS,
    });
    await inviteFriend(t.db, { actor: viewer(inviter), username: who.username });
    expect(await signInAsFriend(who)).toMatchObject({ userId, result: 'ok' });
    expect(await userRow(userId)).toMatchObject({ status: 'active', offboardReason: null });
  });
});

describe('offboarding follows the inviter', () => {
  it("puts the inviter's friends into grace with them, whatever the reason", async () => {
    for (const reason of ['left_guild', 'lost_role', 'self_delete'] as const) {
      const inviter = await member();
      const [a, b] = [discord(), discord()];
      await inviteFriend(t.db, { actor: viewer(inviter), username: a.username });
      await inviteFriend(t.db, { actor: viewer(inviter), username: b.username });
      const friendA = (await signInAsFriend(a))!.userId;
      const friendB = (await signInAsFriend(b))!.userId;
      await offboardUser(t.db, {
        userId: inviter,
        reason,
        graceDays: GRACE_DAYS,
        now: NOW,
        actorLabel: 'worker',
      });
      const inviterRow = await userRow(inviter);
      for (const id of [friendA, friendB]) {
        expect(await userRow(id)).toMatchObject({
          status: 'grace',
          offboardReason: 'inviter_left',
          graceUntil: inviterRow!.graceUntil,
        });
      }
    }
  });

  it('does the same when an admin offboards the inviter', async () => {
    const [inviter, admin] = [await member(), await member()];
    const who = discord();
    await inviteFriend(t.db, { actor: viewer(inviter), username: who.username });
    const { userId } = (await signInAsFriend(who))!;
    await adminOffboardUser(t.db, { actor: viewer(admin, true), userId: inviter, graceDays: 30 });
    expect(await userRow(userId)).toMatchObject({
      status: 'grace',
      offboardReason: 'inviter_left',
    });
  });

  it('lets the friend back in once the inviter is back', async () => {
    const inviter = await member();
    const who = discord();
    await inviteFriend(t.db, { actor: viewer(inviter), username: who.username });
    const { userId } = (await signInAsFriend(who))!;
    await offboardUser(t.db, { userId: inviter, reason: 'left_guild', graceDays: GRACE_DAYS });
    expect(await signInAsFriend(who)).toBeNull();
    await restoreUser(t.db, { userId: inviter, actorLabel: 'login' });
    expect(await signInAsFriend(who)).toMatchObject({ userId, result: 'ok' });
    expect(await userRow(userId)).toMatchObject({ status: 'active' });
  });

  it('leaves a friend alone who has since joined the guild', async () => {
    const inviter = await member();
    const who = discord();
    await inviteFriend(t.db, { actor: viewer(inviter), username: who.username });
    const { userId } = (await signInAsFriend(who))!;
    await recordSignIn(t.db, userId, { ...FRIEND_SNAPSHOT, access: 'member', inviteId: null });
    await offboardUser(t.db, { userId: inviter, reason: 'left_guild', graceDays: GRACE_DAYS });
    expect(await userRow(userId)).toMatchObject({ status: 'active', access: 'member' });
  });
});

describe('offboardStrandedFriends', () => {
  it('offboards active friends without an invite or an active inviter, and nobody else', async () => {
    // Earlier tests leave friends like that behind in this database.
    await offboardStrandedFriends(t.db, { graceDays: GRACE_DAYS, now: NOW });
    const inviter = await member();
    const [kept, orphan] = [discord(), discord()];
    await inviteFriend(t.db, { actor: viewer(inviter), username: kept.username });
    const keptId = (await signInAsFriend(kept))!.userId;
    // A friend whose invite vanished without the cascade (as if the removal's offboarding failed).
    const orphanId = await seedUser(t.db, { discordId: orphan.discordId, access: 'friend' });
    // A friend whose inviter went into grace behind the cascade's back.
    const lateInviter = await member();
    const late = discord();
    await inviteFriend(t.db, { actor: viewer(lateInviter), username: late.username });
    const lateId = (await signInAsFriend(late))!.userId;
    await t.db.update(users).set({ status: 'grace' }).where(eq(users.id, lateInviter));

    expect(await offboardStrandedFriends(t.db, { graceDays: GRACE_DAYS, now: NOW })).toBe(2);
    expect(await userRow(keptId)).toMatchObject({ status: 'active' });
    expect(await userRow(orphanId)).toMatchObject({
      status: 'grace',
      offboardReason: 'invite_removed',
    });
    expect(await userRow(lateId)).toMatchObject({
      status: 'grace',
      offboardReason: 'inviter_left',
    });
    expect(await offboardStrandedFriends(t.db, { graceDays: GRACE_DAYS, now: NOW })).toBe(0);
  });
});

describe('the blacklist', () => {
  it('removes the invite, bars the account, and offboards the friend', async () => {
    const [inviter, admin] = [await member(), await member()];
    const who = discord();
    const invite = await inviteFriend(t.db, { actor: viewer(inviter), username: who.username });
    const { userId } = (await signInAsFriend(who))!;
    expect(
      await blacklistFriend(t.db, {
        actor: viewer(admin, true),
        username: who.username.toUpperCase(),
        graceDays: GRACE_DAYS,
      }),
    ).toEqual({ username: who.username, removedInvite: true, offboarded: true });
    expect(await inviteRow(invite.id)).toBeUndefined();
    expect(await userRow(userId)).toMatchObject({ status: 'grace', offboardReason: 'blacklisted' });
    expect(await listFriendBlacklist(t.db)).toContainEqual(
      expect.objectContaining({ username: who.username, account: true }),
    );
    // A new invite under another name doesn't get the same Discord account back in.
    const other = await member();
    await inviteFriend(t.db, { actor: viewer(other), username: 'brand.new.name' });
    expect(await findFriendInvite(t.db, { ...who, username: 'brand.new.name' })).toBeNull();
    expect(await lastAudit('friend.blacklisted')).toMatchObject({
      actorUserId: admin,
      meta: { username: who.username, removedInvite: true },
    });
  });

  it('can bar a name nobody invited yet, and taking it off lets it be invited again', async () => {
    const [inviter, admin] = [await member(), await member()];
    const { username } = discord();
    expect(
      await blacklistFriend(t.db, { actor: viewer(admin, true), username, graceDays: GRACE_DAYS }),
    ).toEqual({ username, removedInvite: false, offboarded: false });
    await unblacklistFriend(t.db, { actor: viewer(admin, true), username });
    await inviteFriend(t.db, { actor: viewer(inviter), username });
    await expectFriendError(
      unblacklistFriend(t.db, { actor: viewer(admin, true), username }),
      'not_found',
    );
  });

  it('is for admins only', async () => {
    const someone = await member();
    await expect(
      blacklistFriend(t.db, { actor: viewer(someone), username: 'x.y', graceDays: GRACE_DAYS }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(
      await t.db.select().from(friendBlacklist).where(eq(friendBlacklist.username, 'x.y')),
    ).toEqual([]);
  });

  it('lists every invite with its inviter and friend for the admin page', async () => {
    const inviter = await seedUser(t.db, { name: 'Inviter Ian', discordId: discord().discordId });
    const who = discord();
    await inviteFriend(t.db, { actor: viewer(inviter), username: who.username });
    await signInAsFriend(who);
    const row = (await listFriendInvites(t.db)).find((i) => i.username === who.username);
    expect(row).toMatchObject({
      invitedBy: { id: inviter, name: 'Inviter Ian', status: 'active' },
      friend: { name: expect.any(String), status: 'active' },
      joinedAt: NOW,
    });
    const friendId = row!.friend!.id;
    const users = await listUsers(t.db);
    expect(users.find((u) => u.id === friendId)?.friendOf).toBe('Inviter Ian');
    expect(users.find((u) => u.id === inviter)?.friendOf).toBeNull();
  });
});
