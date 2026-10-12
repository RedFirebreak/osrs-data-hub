import { DEFAULT_INVITE_FRIENDS } from '@hub/core';
import { auditLog, hubSettings } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { desc, eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedUser, type SeededUser } from '../accounts/test-support';
import { getInviteFriends, setInviteFriends } from './invite-friends';

let t: TestDatabase;
let admin: SeededUser;

beforeAll(async () => {
  t = await createTestDatabase('invite-friends');
  admin = await seedUser(t.db);
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  await t.db.delete(hubSettings).where(eq(hubSettings.key, 'invite_friends'));
});

async function store(value: unknown): Promise<void> {
  await t.db.insert(hubSettings).values({ key: 'invite_friends', value });
}

describe('getInviteFriends', () => {
  it('is on with three friends per member without a stored value (D-117)', async () => {
    expect(await getInviteFriends(t.db)).toEqual({ enabled: true, maxPerMember: 3 });
    expect(DEFAULT_INVITE_FRIENDS).toEqual({ enabled: true, maxPerMember: 3 });
  });

  it('reads a stored value leniently, each field on its own', async () => {
    await store({ enabled: false, maxPerMember: 5, extra: 1 });
    expect(await getInviteFriends(t.db)).toEqual({ enabled: false, maxPerMember: 5 });

    await t.db.delete(hubSettings).where(eq(hubSettings.key, 'invite_friends'));
    await store({ enabled: false, maxPerMember: 1000 });
    expect(await getInviteFriends(t.db)).toEqual({ enabled: false, maxPerMember: 3 });

    await t.db.delete(hubSettings).where(eq(hubSettings.key, 'invite_friends'));
    await store('off');
    expect(await getInviteFriends(t.db)).toEqual(DEFAULT_INVITE_FRIENDS);
  });
});

describe('setInviteFriends', () => {
  it('stores the setting and audits the change', async () => {
    const settings = await setInviteFriends(t.db, {
      settings: { enabled: false, maxPerMember: 10 },
      actorUserId: admin.id,
    });
    expect(settings).toEqual({ enabled: false, maxPerMember: 10 });
    expect(await getInviteFriends(t.db)).toEqual(settings);
    const [entry] = await t.db
      .select({ meta: auditLog.meta, actor: auditLog.actorUserId, target: auditLog.targetId })
      .from(auditLog)
      .where(eq(auditLog.action, 'hub.invite_friends_changed'))
      .orderBy(desc(auditLog.id))
      .limit(1);
    expect(entry).toEqual({ meta: settings, actor: admin.id, target: 'invite_friends' });
  });

  it('refuses a number of friends outside 1 to 25, and unknown fields', async () => {
    for (const settings of [
      { enabled: true, maxPerMember: 0 },
      { enabled: true, maxPerMember: 26 },
      { enabled: true, maxPerMember: 2.5 },
      { enabled: true, maxPerMember: 3, extra: true },
    ]) {
      await expect(setInviteFriends(t.db, { settings, actorUserId: admin.id })).rejects.toThrow(
        ZodError,
      );
    }
    expect(await getInviteFriends(t.db)).toEqual(DEFAULT_INVITE_FRIENDS);
  });
});
