import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CARD_EVENTS, getDashboard } from './dashboard';
import {
  seedAccount,
  seedEvent,
  seedLatestState,
  seedLink,
  seedSharing,
  seedUser,
  seedXp,
  skillMap,
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
let alpha: SeededAccount;
let bravo: SeededAccount;
let charlie: SeededAccount;
let echo: SeededAccount;
let hidden: SeededAccount;
let bravoSeqs: number[];

const online = (lastSeen: Date) => ({ lastSeen, gameState: 'LOGGED_IN', world: 302 });

beforeAll(async () => {
  t = await createTestDatabase('accounts-dashboard');
  viewer = await seedUser(t.db, { name: 'Viewer' });
  friend = await seedUser(t.db, { name: 'Friend' });
  stranger = await seedUser(t.db, { name: 'Stranger' });
  admin = await seedUser(t.db, { name: 'Admin', isAdmin: true });

  // Owned, offline, with stats and XP history.
  alpha = await seedAccount(t.db, { name: 'Alpha', owner: viewer.id, lastSeen: ago(60 * MIN) });
  await seedLatestState(t.db, alpha.id, {
    ...online(ago(60 * MIN)),
    skills: skillMap({ Attack: [1000, 108], Defence: [500, 5] }),
    skillsUpdatedAt: ago(60 * MIN),
  });
  await seedXp(t.db, alpha.id, [
    ['Overall', '2026-09-27T10:00:00Z', 800],
    ['Overall', '2026-09-27T20:00:00Z', 1000],
    ['Overall', '2026-09-28T08:00:00Z', 1300],
  ]);

  // Contributed, online, no stats ever sent, many events.
  bravo = await seedAccount(t.db, {
    name: 'Bravo',
    owner: friend.id,
    contributors: [viewer.id],
    lastSeen: ago(5 * MIN),
  });
  await seedLatestState(t.db, bravo.id, online(ago(30_000)));
  bravoSeqs = [];
  for (let i = 0; i < CARD_EVENTS + 2; i++) {
    bravoSeqs.push((await seedEvent(t.db, bravo.id, { type: 'loot', valueGp: i })).seq);
  }

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
  hidden = await seedAccount(t.db, {
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

describe('getDashboard', () => {
  it("lists the viewer's own and contributed accounts, most recently seen first", async () => {
    const dash = await getDashboard(t.db, viewer.viewer, { now: NOW });
    expect(dash.accounts.map((a) => [a.name, a.relation])).toEqual([
      ['Bravo', 'contributor'],
      ['Alpha', 'owner'],
    ]);
  });

  it('fills a card with presence, real total level, overall XP and gains', async () => {
    const dash = await getDashboard(t.db, viewer.viewer, { now: NOW });
    const card = dash.accounts.find((a) => a.name === 'Alpha');
    expect(card).toEqual({
      publicId: alpha.publicId,
      name: 'Alpha',
      accountType: 0,
      relation: 'owner',
      presence: {
        visible: true,
        shared: true,
        updatedAt: ago(60 * MIN).toISOString(),
        data: {
          online: false,
          world: 302,
          specialWorld: false,
          gameState: 'LOGGED_IN',
          lastSeen: ago(60 * MIN).toISOString(),
        },
      },
      // min(108, 99) + 5
      totalLevel: 104,
      overallXp: 1500,
      // today (UTC): xp_at(00:00) = 1000; week: no sample before, so the first one (800).
      gains: { today: 500, week: 700 },
      recentEvents: [],
    });
  });

  it('cuts "today" at local midnight in the viewer time zone', async () => {
    const dash = await getDashboard(t.db, viewer.viewer, { now: NOW, timezone: 'Asia/Tokyo' });
    // Tokyo midnight is 2026-09-27T15:00Z: xp_at = 800.
    expect(dash.accounts.find((a) => a.name === 'Alpha')?.gains).toEqual({ today: 700, week: 700 });
  });

  it('has null stats for an account that never sent them, and the newest events', async () => {
    const dash = await getDashboard(t.db, viewer.viewer, { now: NOW });
    const card = dash.accounts.find((a) => a.name === 'Bravo');
    expect(card).toMatchObject({
      totalLevel: null,
      overallXp: null,
      gains: { today: null, week: null },
    });
    expect(card?.presence).toMatchObject({ visible: true, shared: true, data: { online: true } });
    expect(card?.recentEvents.map((e) => e.seq)).toEqual(bravoSeqs.slice(-CARD_EVENTS).reverse());
  });

  it('shows every visible online account with activity, the own ones included', async () => {
    const dash = await getDashboard(t.db, viewer.viewer, { now: NOW });
    expect(dash.onlineNow).toEqual([
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
    const asAdmin = await getDashboard(t.db, admin.viewer, { now: NOW });
    expect(asAdmin.accounts.map((a) => a.publicId)).toEqual([hidden.publicId]);
    expect(asAdmin.onlineNow.map((a) => a.name)).toContain('Hotel');
    const asOwner = await getDashboard(t.db, viewer.viewer, { now: NOW });
    expect(asOwner.onlineNow.map((a) => a.name)).not.toContain('Hotel');
  });

  it('shows presence as not shared for an account without state', async () => {
    const newbie = await seedUser(t.db);
    await seedAccount(t.db, { name: 'India', owner: newbie.id });
    const dash = await getDashboard(t.db, newbie.viewer, { now: NOW });
    expect(dash.accounts[0]?.presence).toEqual({ visible: true, shared: false });
    expect(dash.accounts[0]?.recentEvents).toEqual([]);
  });
});
