/**
 * The read models over data written by the real ingest pipeline from the plugin fixtures
 * (packages/fixtures): what ingest stores is what the pages read, including the special-world,
 * stale-hop, missing-section, resend and redaction cases.
 */
import type { Viewer } from '@hub/core';
import { osrsAccounts } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FeedEvent } from '../feed';
import {
  createHarness,
  newHash,
  realTotalLevel,
  wire,
  type Harness,
  type SeededDevice,
  type Wire,
} from '../ingest/test-support';
import { getAccountPage, type AccountPage } from './account-page';
import { getGuildOverview } from './guild';
import { listFeed } from './list-feed';
import { getOnlineNow } from './online-now';
import { seedSharing } from './test-support';
import { getGains } from './xp';

const MIN = 60_000;
const HOUR = 60 * MIN;

let t: TestDatabase;
let h: Harness;
let owner: Viewer;
let member: Viewer;
let ownerDevice: SeededDevice;
let ironDevice: SeededDevice;
/** Zezima under a fresh hash (its fixtures aren't XP-consistent over time). */
let hash: string;
let publicId: string;
let ironPublicId: string;
/** snapshot-normal's root timestamp. */
let t0: number;
let normal: Wire;
const ATTACK_GAIN = 5_000;

const viewer = (userId: string): Viewer => ({ userId, status: 'active', isAdmin: false });

function data<T>(section: { visible: boolean; shared?: boolean; data?: T }): T {
  if (!section.visible || !section.shared) throw new Error('section has no data');
  return section.data as T;
}

async function page(v: Viewer, id: string, now: number): Promise<AccountPage> {
  const p = await getAccountPage(t.db, v, id, { now: new Date(now) });
  if (!p) throw new Error('page missing');
  return p;
}

/**
 * A Zezima fixture re-keyed to `hash`, sent `offset` ms after t0. Its stats are dropped, or with
 * `gained` raised to the XP of the second snapshot below, so the XP guard (D-24) doesn't trip on the
 * fixture's older values.
 */
async function sendZezima(
  name: Parameters<typeof wire>[0],
  offset: number,
  stats: 'drop' | 'gained' | 'as sent',
): Promise<void> {
  const body = wire(name, { hash, freshEventIds: true });
  body.timestamp = t0 + offset;
  if (stats === 'drop' && body.player) delete body.player.stats;
  const attack = body.player?.stats?.skills.Attack;
  if (stats === 'gained' && attack) attack.xp += ATTACK_GAIN;
  expect((await h.send(ownerDevice, body, { at: t0 + offset + 1_000 })).status).toBe(200);
}

const locationOf = (e: FeedEvent) =>
  ((e.data as { data?: Record<string, unknown> }).data ?? {}).location;

beforeAll(async () => {
  t = await createTestDatabase('accounts-fixtures');
  h = createHarness(t);
  const ownerId = await h.seedUser();
  owner = viewer(ownerId);
  member = viewer(await h.seedUser());
  const ironId = await h.seedUser();
  ownerDevice = await h.seedDevice(ownerId);
  ironDevice = await h.seedDevice(ironId);
  hash = newHash();

  normal = wire('snapshot-normal', { hash });
  t0 = normal.timestamp as number;
  expect((await h.send(ownerDevice, normal, { at: t0 + 1_000 })).status).toBe(200);
  publicId = await publicIdOf(hash);

  const death = wire('event-death-dangerous', { freshEventIds: true });
  expect((await h.send(ironDevice, death)).status).toBe(200);
  ironPublicId = await publicIdOf(death.player?.accountHash as string);
});

async function publicIdOf(accountHash: string): Promise<string> {
  const [row] = await t.db
    .select({ publicId: osrsAccounts.publicId })
    .from(osrsAccounts)
    .where(eq(osrsAccounts.accountHash, accountHash));
  if (!row) throw new Error('account missing');
  return row.publicId;
}

/** Takes both location categories away from the guild, so a member has no location category. */
async function keepLocationPrivate(accountPublicId: string): Promise<void> {
  const [row] = await t.db
    .select({ id: osrsAccounts.id })
    .from(osrsAccounts)
    .where(eq(osrsAccounts.publicId, accountPublicId));
  if (!row) throw new Error('account missing');
  await seedSharing(t.db, row.id, 'location_live', 'private');
  await seedSharing(t.db, row.id, 'location_history', 'private');
}

afterAll(async () => {
  await t.drop();
});

describe('a normal snapshot (snapshot-normal)', () => {
  it('shows the real total level and overall XP (PLUGIN-9, D-44)', async () => {
    const skills = data((await page(owner, publicId, t0 + 2_000)).skills);
    expect(skills.totalLevel).toBe(realTotalLevel(normal));
    expect(skills.totalLevel).toBe(2372);
    const sent = Object.values(normal.player?.stats?.skills ?? {});
    expect(skills.overallXp).toBe(sent.reduce((sum, s) => sum + s.xp, 0));
    expect(skills.rows).toHaveLength(sent.length + 1);
    expect(skills.rows[0]).toMatchObject({ skill: 'Overall', level: 2372, realLevel: 2372 });
  });

  it('shows the owner every section, and by default a member too', async () => {
    const asOwner = await page(owner, publicId, t0 + 2_000);
    expect(data(asOwner.presence)).toMatchObject({ online: true, world: 302, specialWorld: false });
    expect(data(asOwner.vitals)).toEqual({
      hp: { current: 99, max: 99 },
      prayer: { current: 99, max: 99 },
      spellbook: 'lunar',
    });
    expect(data(asOwner.location)).toEqual({
      x: 3164,
      y: 3487,
      plane: 0,
      isOnBoat: false,
      stale: false,
    });
    const items = normal.player?.inventory as { items: { gePrice: number; quantity: number }[] };
    expect(data(asOwner.inventory).items).toHaveLength(items.items.length);
    expect(data(asOwner.inventory).value).toBe(
      items.items.reduce((sum, i) => sum + i.gePrice * i.quantity, 0),
    );
    expect(data(asOwner.equipment).items.length).toBeGreaterThan(0);

    const asMember = await page(member, publicId, t0 + 2_000);
    // Every category is a guild category by default (D-96).
    expect(data(asMember.location)).toEqual(data(asOwner.location));
    expect(data(asMember.equipment)).toEqual(data(asOwner.equipment));
    expect(data(asMember.inventory)).toEqual(data(asOwner.inventory));
    expect(asMember.skills.visible && asMember.skills.shared).toBe(true);
    expect(asMember.recentEvents).toEqual({ visible: true, shared: false });
  });
});

describe('gains from ingested snapshots, and what special worlds leave out', () => {
  beforeAll(async () => {
    const later = wire('snapshot-normal', { hash });
    later.timestamp = t0 + HOUR;
    const attack = later.player?.stats?.skills.Attack;
    if (!attack) throw new Error('fixture without Attack');
    attack.xp += ATTACK_GAIN;
    expect((await h.send(ownerDevice, later, { at: t0 + HOUR + 1_000 })).status).toBe(200);
    // A Leagues character under the same hash, then the stale hop back (both special by
    // worldTypes, PLUGIN-8): presence moves, stats don't.
    await sendZezima('special-world-seasonal', 2 * HOUR, 'as sent');
    await sendZezima('hop-from-special-world-stale', 2 * HOUR + 10 * MIN, 'as sent');
  });

  it('counts the XP gained between two snapshots', async () => {
    const gains = await getGains(t.db, (await h.accountIdByHash(hash)) as number, {
      from: new Date(t0 + 30 * MIN),
    });
    expect(gains.get('Attack')).toBe(ATTACK_GAIN);
    expect(gains.get('Overall')).toBe(ATTACK_GAIN);
    expect(gains.get('Defence')).toBe(0);
  });

  it('keeps the normal-world stats while presence shows the special world', async () => {
    const p = await page(owner, publicId, t0 + 2 * HOUR + 11 * MIN);
    expect(data(p.presence)).toMatchObject({ world: 485, specialWorld: true, online: true });
    const skills = data(p.skills);
    expect(skills.totalLevel).toBe(2372);
    expect(skills.rows.find((r) => r.skill === 'Attack')?.xp).toBe(
      (normal.player?.stats?.skills.Attack?.xp ?? 0) + ATTACK_GAIN,
    );
    // The location is still the normal world's: special-world payloads don't move it.
    expect(data(p.location)).toMatchObject({ x: 3164, y: 3487 });
  });

  it('lists the special-world level-up in the feed, flagged, but not in gains', async () => {
    const feed = await listFeed(t.db, member, { accountPublicId: publicId });
    expect(feed.map((e) => [e.type, e.specialWorld])).toEqual([['level_up', true]]);
    const now = new Date(t0 + 2 * HOUR + 11 * MIN);
    const skills = data((await page(owner, publicId, now.getTime())).skills);
    expect(skills.rows.find((r) => r.skill === 'Overall')?.gains.week).toBe(ATTACK_GAIN);
    const { leaderboards } = await getGuildOverview(t.db, member, { now });
    const overall = leaderboards.week.find((b) => b.skill === 'Overall')?.entries;
    expect(overall).toEqual([{ publicId, name: 'Zezima', gain: ATTACK_GAIN }]);
    expect(leaderboards.week.map((b) => b.skill)).toEqual(['Overall', 'Attack']);
  });
});

describe('sections the plugin stops sending (snapshot-no-sections, D-18)', () => {
  it('keeps their last values and times', async () => {
    const before = await page(owner, publicId, t0 + 2 * HOUR + 11 * MIN);
    await sendZezima('snapshot-no-sections', 3 * HOUR, 'gained');
    const after = await page(owner, publicId, t0 + 3 * HOUR + 2_000);
    for (const key of ['equipment', 'inventory'] as const) {
      expect(after[key]).toEqual(before[key]);
    }
    const location = after.location as { updatedAt: string; data: { stale: boolean } };
    expect(location.updatedAt).toBe((before.location as { updatedAt: string }).updatedAt);
    expect(location.data.stale).toBe(true);
    expect((after.skills as { updatedAt: string }).updatedAt).toBe(
      new Date(t0 + 3 * HOUR + 1_000).toISOString(),
    );
  });
});

describe('events from the fixtures', () => {
  it('strips superior and death locations for members, keeps them for the owner', async () => {
    await keepLocationPrivate(publicId);
    await keepLocationPrivate(ironPublicId);
    await sendZezima('event-superior', 4 * HOUR, 'drop');
    const [superior] = await listFeed(t.db, member, {
      accountPublicId: publicId,
      types: ['superior_spawn'],
    });
    expect(superior).toMatchObject({ type: 'superior_spawn', npcId: 7411 });
    expect(superior && locationOf(superior)).toBeUndefined();
    const [own] = await listFeed(t.db, owner, {
      accountPublicId: publicId,
      types: ['superior_spawn'],
    });
    expect(own && locationOf(own)).toEqual({ x: 1698, y: 10082, plane: 0 });

    const [death] = await listFeed(t.db, member, { accountPublicId: ironPublicId });
    expect(death).toMatchObject({ type: 'death', valueGp: 34_906 });
    expect(death && locationOf(death)).toBeUndefined();
    expect(JSON.stringify(death)).not.toMatch(/3858|3068/);
    expect((death?.data as { data: { killerName: string } }).data.killerName).toBe('Lynx Titan');
  });

  it('shows a resent payload once (retry-duplicate-a/b)', async () => {
    const a = wire('retry-duplicate-a', { hash });
    const b = wire('retry-duplicate-b', { hash });
    for (const body of [a, b]) {
      body.timestamp = t0 + 5 * HOUR;
      if (body.player) delete body.player.stats;
      expect((await h.send(ownerDevice, body, { at: t0 + 5 * HOUR + 1_000 })).status).toBe(200);
    }
    const loot = await listFeed(t.db, member, { accountPublicId: publicId, types: ['loot'] });
    expect(loot).toHaveLength(1);
  });

  it('splits a multi-skill level-up into one feed entry each (event-levelup-multi)', async () => {
    const body = wire('event-levelup-multi', { freshEventIds: true });
    expect((await h.send(ironDevice, body)).status).toBe(200);
    const levels = await listFeed(t.db, member, {
      accountPublicId: ironPublicId,
      types: ['level_up'],
    });
    // Combat comes as a level-up of its own (the plugin's HashMap order: Hitpoints, Combat, …).
    expect(levels.map((e) => [e.skill, e.level]).sort()).toEqual([
      ['Combat', 101],
      ['Hitpoints', 84],
      ['Strength', 85],
    ]);
  });
});

describe('logging out (logout)', () => {
  it('takes the account out of "online now" and closes its presence', async () => {
    const before = await getOnlineNow(t.db, member, { now: new Date(t0 + 6 * HOUR) });
    await sendZezima('snapshot-normal', 6 * HOUR, 'gained');
    const online = await getOnlineNow(t.db, member, { now: new Date(t0 + 6 * HOUR + 2_000) });
    expect(online.map((e) => e.publicId)).toContain(publicId);
    expect(before.map((e) => e.publicId)).not.toContain(publicId);

    await sendZezima('logout', 6 * HOUR + 5 * MIN, 'drop');
    const now = t0 + 6 * HOUR + 5 * MIN + 2_000;
    const after = await getOnlineNow(t.db, member, { now: new Date(now) });
    expect(after.map((e) => e.publicId)).not.toContain(publicId);
    expect(data((await page(member, publicId, now)).presence)).toMatchObject({
      online: false,
      gameState: 'LOGIN_SCREEN',
    });
  });
});

describe('every event fixture in the feed', () => {
  const EVENT_FIXTURES = [
    'event-loot',
    'event-pkloot',
    'event-death-dangerous',
    'event-death-safe',
    'event-levelup-multi',
    'event-collectionlog',
    'event-collectionlog-unresolved',
    'event-combattask',
    'event-diary-repeat',
    'event-superior',
    'event-unknown-type',
  ] as const;

  it.each(EVENT_FIXTURES)('%s: described, and without coordinates for a member', async (name) => {
    const body = wire(name, { hash: newHash(), name: `P ${name}`, freshEventIds: true });
    expect((await h.send(ownerDevice, body)).status).toBe(200);
    const id = await publicIdOf(body.player?.accountHash as string);
    await keepLocationPrivate(id);
    const asMember = await listFeed(t.db, member, { accountPublicId: id });
    expect(asMember.length).toBeGreaterThanOrEqual(body.events?.length ?? 0);
    for (const e of asMember) {
      expect(e.title).not.toBe('');
      expect(e.line).toContain(`P ${name}`);
      expect(e.specialWorld).toBe(false);
    }
    expect(JSON.stringify(asMember)).not.toContain('"location"');
    const asOwner = await listFeed(t.db, owner, { accountPublicId: id });
    expect(asOwner.map((e) => e.id)).toEqual(asMember.map((e) => e.id));
  });
});
