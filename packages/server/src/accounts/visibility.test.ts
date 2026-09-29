/**
 * Handoff §10 end to end: every sharing rule, asserted through the read models the UI uses.
 */
import { DEFAULT_GUILD_FEED_FILTER } from '@hub/core';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAccountPage } from './account-page';
import { getDashboard } from './dashboard';
import { getGuildOverview } from './guild';
import { getEquipmentHistory, getLocationHistory, getSessions, getWealthHistory } from './history';
import { listFeed } from './list-feed';
import {
  deathData,
  seedAccount,
  seedEvent,
  seedGrant,
  seedLatestState,
  seedLink,
  seedSharing,
  seedUser,
  skillMap,
  superiorData,
  type SeededAccount,
  type SeededUser,
} from './test-support';

const NOW = new Date('2026-09-28T12:00:00Z');
const RANGE = { from: new Date('2026-09-01T00:00:00Z'), to: NOW };
const opts = { now: NOW };

let t: TestDatabase;
let owner: SeededUser;
let contributor: SeededUser;
let blocked: SeededUser;
let member: SeededUser;
let grantee: SeededUser;
let admin: SeededUser;
let inGrace: SeededUser;
/** Default sharing, every section sent. */
let open: SeededAccount;
/** events private; equipment selected (grantee); location_history selected (grantee). */
let restricted: SeededAccount;
/** Hidden (owner offboarded without a transfer). */
let hidden: SeededAccount;
/** Only presence was ever received. */
let bare: SeededAccount;

const fullState = {
  lastSeen: new Date(NOW.getTime() - 30_000),
  gameState: 'LOGGED_IN',
  world: 302,
  worldUpdatedAt: NOW,
  hpCurrent: 90,
  hpMax: 99,
  healthUpdatedAt: NOW,
  location: { x: 3164, y: 3487, plane: 0, isOnBoat: false },
  locationUpdatedAt: NOW,
  skills: skillMap({ Attack: [13_034_431, 99] }),
  skillsUpdatedAt: NOW,
  inventory: [{ id: 385, name: 'Shark', gePrice: 900, quantity: 1 }],
  inventoryUpdatedAt: NOW,
  equipment: [{ id: 4151, name: 'Abyssal whip', gePrice: 1_000_000, quantity: 1 }],
  equipmentUpdatedAt: NOW,
};

async function seedEvents(accountId: number): Promise<void> {
  await seedEvent(t.db, accountId, { type: 'loot', valueGp: 1000 });
  await seedEvent(t.db, accountId, { type: 'death', data: deathData() });
  await seedEvent(t.db, accountId, { type: 'superior_spawn', data: superiorData() });
}

beforeAll(async () => {
  t = await createTestDatabase('accounts-visibility');
  owner = await seedUser(t.db, { name: 'Owner' });
  contributor = await seedUser(t.db, { name: 'Contributor' });
  blocked = await seedUser(t.db, { name: 'Blocked' });
  member = await seedUser(t.db, { name: 'Member' });
  grantee = await seedUser(t.db, { name: 'Grantee' });
  admin = await seedUser(t.db, { name: 'Admin', isAdmin: true });
  inGrace = await seedUser(t.db, { name: 'Grace', status: 'grace' });

  open = await seedAccount(t.db, { name: 'Open', owner: owner.id, contributors: [contributor.id] });
  await seedLink(t.db, open.id, blocked.id, { blocked: true });
  await seedLatestState(t.db, open.id, fullState);
  await seedEvents(open.id);

  restricted = await seedAccount(t.db, { name: 'Restricted', owner: owner.id });
  await seedLink(t.db, restricted.id, blocked.id, { blocked: true });
  await seedLatestState(t.db, restricted.id, fullState);
  await seedEvents(restricted.id);
  await seedSharing(t.db, restricted.id, 'events', 'private');
  await seedSharing(t.db, restricted.id, 'equipment', 'selected');
  await seedSharing(t.db, restricted.id, 'location_history', 'selected');
  await seedGrant(t.db, restricted.id, 'equipment', grantee.id);
  await seedGrant(t.db, restricted.id, 'location_history', grantee.id);
  // A grant on a category whose audience isn't 'selected' has no effect.
  await seedGrant(t.db, restricted.id, 'inventory', grantee.id);

  hidden = await seedAccount(t.db, {
    name: 'Hidden',
    owner: owner.id,
    contributors: [contributor.id],
    status: 'hidden',
  });
  await seedLatestState(t.db, hidden.id, fullState);
  await seedEvents(hidden.id);

  bare = await seedAccount(t.db, { name: 'Bare', owner: owner.id });
  await seedLatestState(t.db, bare.id, { lastSeen: NOW, gameState: 'LOGIN_SCREEN' });
});

afterAll(async () => {
  await t.drop();
});

describe('default audiences (stats, events, activity, live location → guild; the rest private; D-82)', () => {
  it('shows a guild member the guild categories and hides the private ones', async () => {
    const page = await getAccountPage(t.db, member.viewer, open.publicId, opts);
    expect(page?.account.relation).toBe('member');
    expect(page?.account.canManage).toBe(false);
    expect(page?.presence.visible).toBe(true);
    expect(page?.vitals.visible).toBe(true);
    expect(page?.skills.visible).toBe(true);
    expect(page?.recentEvents.visible).toBe(true);
    expect(page?.location).toMatchObject({ visible: true, shared: true });
    expect(page?.equipment).toEqual({ visible: false });
    expect(page?.inventory).toEqual({ visible: false });
  });

  it('shows owners and contributors everything', async () => {
    for (const viewer of [owner.viewer, contributor.viewer]) {
      const page = await getAccountPage(t.db, viewer, open.publicId, opts);
      for (const section of [page?.location, page?.equipment, page?.inventory]) {
        expect(section).toMatchObject({ visible: true, shared: true });
      }
    }
  });

  it('gates the histories by their categories', async () => {
    expect(await getSessions(t.db, member.viewer, open.publicId, RANGE)).toEqual([]);
    expect(await getEquipmentHistory(t.db, member.viewer, open.publicId, RANGE)).toBeNull();
    expect(await getWealthHistory(t.db, member.viewer, open.publicId, RANGE)).toBeNull();
    expect(await getLocationHistory(t.db, member.viewer, open.publicId, RANGE)).toBeNull();
    expect(await getLocationHistory(t.db, owner.viewer, open.publicId, RANGE)).toEqual([]);
  });
});

describe('private and selected audiences, grants', () => {
  it('hides a private category from members but not from the owner', async () => {
    const asMember = await getAccountPage(t.db, member.viewer, restricted.publicId, opts);
    expect(asMember?.recentEvents).toEqual({ visible: false });
    const asOwner = await getAccountPage(t.db, owner.viewer, restricted.publicId, opts);
    expect(asOwner?.recentEvents.visible).toBe(true);
  });

  it('shows a selected category only to grantees', async () => {
    const asGrantee = await getAccountPage(t.db, grantee.viewer, restricted.publicId, opts);
    expect(asGrantee?.equipment).toMatchObject({ visible: true, shared: true });
    const asMember = await getAccountPage(t.db, member.viewer, restricted.publicId, opts);
    expect(asMember?.equipment).toEqual({ visible: false });
    expect(await getEquipmentHistory(t.db, grantee.viewer, restricted.publicId, RANGE)).toEqual([]);
  });

  it('ignores a grant while the audience is not selected', async () => {
    const asGrantee = await getAccountPage(t.db, grantee.viewer, restricted.publicId, opts);
    expect(asGrantee?.inventory).toEqual({ visible: false });
  });
});

describe('blocked contributors', () => {
  it('treats a blocked contributor as a plain member', async () => {
    const page = await getAccountPage(t.db, blocked.viewer, restricted.publicId, opts);
    expect(page?.account.relation).toBe('member');
    expect(page?.recentEvents).toEqual({ visible: false });
    expect(page?.equipment).toEqual({ visible: false });
    expect(page?.skills.visible).toBe(true);
  });

  it("leaves the account off the blocked user's dashboard", async () => {
    const dash = await getDashboard(t.db, blocked.viewer, opts);
    expect(dash.accounts).toEqual([]);
  });
});

describe('hidden accounts', () => {
  it('are invisible to members, contributors and even the owner', async () => {
    for (const viewer of [member.viewer, contributor.viewer, owner.viewer]) {
      expect(await getAccountPage(t.db, viewer, hidden.publicId, opts)).toBeNull();
      expect(await listFeed(t.db, viewer, { accountPublicId: hidden.publicId })).toEqual([]);
      expect(await getSessions(t.db, viewer, hidden.publicId, RANGE)).toBeNull();
    }
    const feed = await listFeed(t.db, member.viewer);
    expect(feed.some((e) => e.account.publicId === hidden.publicId)).toBe(false);
    const dash = await getDashboard(t.db, contributor.viewer, opts);
    expect(dash.accounts.map((a) => a.publicId)).toEqual([open.publicId]);
  });

  it('are visible to admins, flagged hidden', async () => {
    const page = await getAccountPage(t.db, admin.viewer, hidden.publicId, opts);
    expect(page?.account.hidden).toBe(true);
    expect(page?.account.canManage).toBe(true);
    expect(page?.account.relation).toBe('member');
    const feed = await listFeed(t.db, admin.viewer, { accountPublicId: hidden.publicId });
    expect(feed).toHaveLength(3);
  });
});

describe('inactive viewers', () => {
  it('see nothing at all', async () => {
    expect(await getAccountPage(t.db, inGrace.viewer, open.publicId, opts)).toBeNull();
    expect(await listFeed(t.db, inGrace.viewer)).toEqual([]);
    expect(await getDashboard(t.db, inGrace.viewer, opts)).toEqual({
      accounts: [],
      onlineNow: [],
    });
    expect(await getGuildOverview(t.db, inGrace.viewer, opts)).toEqual({
      members: [],
      feed: [],
      feedFilter: DEFAULT_GUILD_FEED_FILTER,
      leaderboards: { day: [], week: [], month: [] },
    });
  });

  it('applies to admins in grace too', async () => {
    const graceAdmin = await seedUser(t.db, { isAdmin: true, status: 'grace' });
    expect(await getAccountPage(t.db, graceAdmin.viewer, hidden.publicId, opts)).toBeNull();
  });
});

describe('redaction of event locations', () => {
  const locationOf = (e: { data: unknown }) =>
    ((e.data as { data?: Record<string, unknown> }).data ?? {}).location;

  // A plain member has no location category on `open` once live location isn't shared (D-82).
  beforeAll(async () => {
    await seedSharing(t.db, open.id, 'location_live', 'private');
  });

  it('strips death and superior locations without a location category', async () => {
    const feed = await listFeed(t.db, member.viewer, { accountPublicId: open.publicId });
    const withLocation = feed.filter((e) => e.type !== 'loot');
    expect(withLocation.map((e) => e.type).sort()).toEqual(['death', 'superior_spawn']);
    for (const e of withLocation) expect(locationOf(e)).toBeUndefined();
    // The rest of the event is intact.
    const death = feed.find((e) => e.type === 'death');
    expect((death?.data as { data: { valueLost: number } }).data.valueLost).toBe(34906);
  });

  it('keeps them for viewers with location_live or location_history', async () => {
    const asOwner = await listFeed(t.db, owner.viewer, { accountPublicId: open.publicId });
    expect(locationOf(asOwner.find((e) => e.type === 'death') ?? { data: null })).toEqual({
      x: 3068,
      y: 3858,
      plane: 0,
    });
    // The grantee has location_history on `restricted` but its events are private: nothing leaks.
    expect(await listFeed(t.db, grantee.viewer, { accountPublicId: restricted.publicId })).toEqual(
      [],
    );
    // Give the grantee the events too: now the locations come through.
    await seedSharing(t.db, open.id, 'location_history', 'selected');
    await seedGrant(t.db, open.id, 'location_history', grantee.id);
    const asGrantee = await listFeed(t.db, grantee.viewer, { accountPublicId: open.publicId });
    expect(
      locationOf(asGrantee.find((e) => e.type === 'superior_spawn') ?? { data: null }),
    ).toEqual({ x: 1698, y: 10082, plane: 0 });
  });

  it('redacts dashboard and account page events the same way', async () => {
    const page = await getAccountPage(t.db, member.viewer, open.publicId, opts);
    const events =
      page?.recentEvents.visible && page.recentEvents.shared ? page.recentEvents.data : [];
    expect(events.find((e) => e.type === 'death')).toBeDefined();
    for (const e of events) expect(locationOf(e)).toBeUndefined();
  });
});

describe('"not shared" versus not visible', () => {
  it('reports sections the plugin never sent as not shared', async () => {
    const page = await getAccountPage(t.db, owner.viewer, bare.publicId, opts);
    const notShared = { visible: true, shared: false };
    expect(page?.vitals).toEqual(notShared);
    expect(page?.location).toEqual(notShared);
    expect(page?.skills).toEqual(notShared);
    expect(page?.equipment).toEqual(notShared);
    expect(page?.inventory).toEqual(notShared);
    expect(page?.recentEvents).toEqual(notShared);
    expect(page?.presence).toMatchObject({ visible: true, shared: true });
  });

  it('reports not visible before not shared', async () => {
    const page = await getAccountPage(t.db, member.viewer, bare.publicId, opts);
    expect(page?.equipment).toEqual({ visible: false });
    expect(page?.skills).toEqual({ visible: true, shared: false });
  });

  it('hides an account from a member when nothing of it is shared with them', async () => {
    const secret = await seedAccount(t.db, { owner: owner.id });
    for (const category of ['stats', 'events', 'activity', 'location_live'] as const) {
      await seedSharing(t.db, secret.id, category, 'private');
    }
    expect(await getAccountPage(t.db, member.viewer, secret.publicId, opts)).toBeNull();
    expect(await getAccountPage(t.db, owner.viewer, secret.publicId, opts)).not.toBeNull();
  });
});
