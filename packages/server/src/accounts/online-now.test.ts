import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getOnlineNow } from './online-now';
import {
  seedAccount,
  seedLatestState,
  seedLink,
  seedSharing,
  seedUser,
  type SeededAccount,
  type SeededUser,
} from './test-support';

const NOW = new Date('2026-09-28T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;

let t: TestDatabase;
let viewer: SeededUser;
let friend: SeededUser;
let stranger: SeededUser;
let admin: SeededUser;
let bravo: SeededAccount;
let charlie: SeededAccount;
let echo: SeededAccount;

const online = (lastSeen: Date) => ({ lastSeen, gameState: 'LOGGED_IN', world: 302 });

beforeAll(async () => {
  t = await createTestDatabase('accounts-online-now');
  viewer = await seedUser(t.db, { name: 'Viewer' });
  friend = await seedUser(t.db, { name: 'Friend' });
  stranger = await seedUser(t.db, { name: 'Stranger' });
  admin = await seedUser(t.db, { name: 'Admin', isAdmin: true });

  // Owned and offline for an hour.
  const alpha = await seedAccount(t.db, {
    name: 'Alpha',
    owner: viewer.id,
    lastSeen: ago(60 * MIN),
  });
  await seedLatestState(t.db, alpha.id, online(ago(60 * MIN)));

  // Contributed and online.
  bravo = await seedAccount(t.db, {
    name: 'Bravo',
    owner: friend.id,
    contributors: [viewer.id],
    lastSeen: ago(5 * MIN),
  });
  await seedLatestState(t.db, bravo.id, online(ago(30_000)));

  // The viewer is blocked here: not theirs, but online and visible to the guild.
  charlie = await seedAccount(t.db, { name: 'Charlie', owner: friend.id, lastSeen: ago(MIN) });
  await seedLink(t.db, charlie.id, viewer.id, { blocked: true });
  await seedLatestState(t.db, charlie.id, online(ago(MIN)));

  // Online but activity is private.
  const delta = await seedAccount(t.db, { name: 'Delta', owner: stranger.id });
  await seedSharing(t.db, delta.id, 'activity', 'private');
  await seedLatestState(t.db, delta.id, online(ago(MIN)));

  // Online on a special world (lowercase name: the sort ignores case).
  echo = await seedAccount(t.db, { name: 'echo', owner: stranger.id });
  await seedLatestState(t.db, echo.id, { ...online(ago(MIN)), world: 330, specialWorld: true });

  // Offline by timeout (25 min without tickDelay), and on the login screen.
  const foxtrot = await seedAccount(t.db, { name: 'Foxtrot', owner: stranger.id });
  await seedLatestState(t.db, foxtrot.id, online(ago(26 * MIN)));
  const golf = await seedAccount(t.db, { name: 'Golf', owner: stranger.id });
  await seedLatestState(t.db, golf.id, { lastSeen: NOW, gameState: 'LOGIN_SCREEN' });

  // Hidden: invisible to its owner, visible to an admin contributor.
  const hidden = await seedAccount(t.db, {
    name: 'Hotel',
    owner: viewer.id,
    contributors: [admin.id],
    status: 'hidden',
  });
  await seedLatestState(t.db, hidden.id, online(ago(MIN)));
});

afterAll(async () => {
  await t.drop();
});

describe('getOnlineNow', () => {
  it('lists every visible online account with activity, the own ones included', async () => {
    expect(await getOnlineNow(t.db, viewer.viewer, { now: NOW })).toEqual([
      {
        publicId: bravo.publicId,
        name: 'Bravo',
        accountType: 0,
        world: 302,
        specialWorld: false,
        lastSeen: ago(30_000).toISOString(),
      },
      expect.objectContaining({ publicId: charlie.publicId }),
      expect.objectContaining({ publicId: echo.publicId, world: 330, specialWorld: true }),
    ]);
  });

  it('shows hidden accounts only to admins', async () => {
    const asAdmin = await getOnlineNow(t.db, admin.viewer, { now: NOW });
    expect(asAdmin.map((a) => a.name)).toContain('Hotel');
    const asOwner = await getOnlineNow(t.db, viewer.viewer, { now: NOW });
    expect(asOwner.map((a) => a.name)).not.toContain('Hotel');
  });

  it('shows nobody to someone who is no longer active', async () => {
    expect(await getOnlineNow(t.db, { ...viewer.viewer, status: 'grace' }, { now: NOW })).toEqual(
      [],
    );
  });
});
