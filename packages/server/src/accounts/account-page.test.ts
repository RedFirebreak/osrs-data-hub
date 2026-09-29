import { accountNames } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAGE_EVENTS, getAccountPage, type AccountPage } from './account-page';
import {
  seedAccount,
  seedEvent,
  seedLatestState,
  seedSharing,
  seedUser,
  seedXp,
  skillMap,
  type SeededAccount,
  type SeededUser,
} from './test-support';

const NOW = new Date('2026-09-28T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

let t: TestDatabase;
let owner: SeededUser;
let member: SeededUser;
let zezima: SeededAccount;
let quiet: SeededAccount;
let ownerless: SeededAccount;
let eventSeqs: number[];

function data<T>(section: { visible: boolean; shared?: boolean; data?: T }): T {
  if (!section.visible || !section.shared) throw new Error('section has no data');
  return section.data as T;
}

beforeAll(async () => {
  t = await createTestDatabase('accounts-page');
  owner = await seedUser(t.db, { name: 'Owner', image: 'https://cdn.example/owner.png' });
  member = await seedUser(t.db, { name: 'Member' });

  zezima = await seedAccount(t.db, {
    name: 'Zezima',
    owner: owner.id,
    accountType: 1,
    firstSeen: new Date('2025-01-01T00:00:00Z'),
    lastSeen: ago(30_000),
  });
  await t.db.insert(accountNames).values([
    { accountId: zezima.id, name: 'Older Zez', lastSeen: new Date('2026-01-01T00:00:00Z') },
    { accountId: zezima.id, name: 'Old Zez', lastSeen: new Date('2026-06-01T00:00:00Z') },
    { accountId: zezima.id, name: 'Zezima', lastSeen: NOW },
  ]);
  await seedLatestState(t.db, zezima.id, {
    lastSeen: ago(30_000),
    gameState: 'LOGGED_IN',
    tickDelay: 50,
    world: 302,
    worldUpdatedAt: ago(30_000),
    hpCurrent: 95,
    hpMax: 99,
    healthUpdatedAt: ago(60_000),
    spellbookId: 2,
    spellbook: 'lunar',
    spellbookUpdatedAt: ago(30_000),
    location: { x: 3164, y: 3487, plane: 1, isOnBoat: true },
    locationUpdatedAt: ago(3 * 60_000),
    skills: skillMap({
      Mining: [0, 1],
      Attack: [34_512_847, 108],
      Hitpoints: [13_034_431, 99],
      Newskill: [100, 2],
    }),
    skillsUpdatedAt: ago(30_000),
    inventory: [
      { id: 385, name: 'Shark', gePrice: 900, quantity: 1 },
      { id: 385, name: 'Shark', gePrice: 900, quantity: 1 },
      { id: 995, name: 'Coins', gePrice: 1, quantity: 25_000 },
    ],
    inventoryUpdatedAt: ago(30_000),
    equipment: [
      { id: 4151, name: 'Abyssal whip', gePrice: 1_000_000, quantity: 1, equipmentSlot: 'WEAPON' },
    ],
    equipmentUpdatedAt: ago(45_000),
  });
  await seedXp(t.db, zezima.id, [
    ['Attack', '2025-09-01T10:00:00Z', 20_000_000],
    ['Attack', '2026-01-01T10:00:00Z', 30_000_000],
    ['Attack', '2026-09-01T10:00:00Z', 33_000_000],
    ['Attack', '2026-09-25T10:00:00Z', 34_000_000],
    ['Attack', '2026-09-27T21:55:00Z', 34_400_000],
    ['Attack', '2026-09-27T23:00:00Z', 34_450_000],
  ]);
  eventSeqs = [];
  for (let i = 0; i < PAGE_EVENTS + 5; i++) {
    const { seq } = await seedEvent(t.db, zezima.id, {
      type: 'level_up',
      skill: 'Attack',
      level: 80 + (i % 20),
      occurredAt: ago((30 - i) * 60_000),
    });
    eventSeqs.push(seq);
  }

  quiet = await seedAccount(t.db, { name: 'Quiet', owner: owner.id });
  await seedSharing(t.db, quiet.id, 'activity', 'private');
  await seedLatestState(t.db, quiet.id, {
    lastSeen: ago(10 * 60_000),
    gameState: 'LOGGED_IN',
    world: 330,
    specialWorld: true,
    locationUpdatedAt: ago(30_000),
    location: { x: 1, y: 2, plane: 0 },
  });

  ownerless = await seedAccount(t.db, { name: 'Ownerless', owner: null });
});

afterAll(async () => {
  await t.drop();
});

describe('getAccountPage header', () => {
  it('describes the account, its owner and previous names', async () => {
    const page = await getAccountPage(t.db, owner.viewer, zezima.publicId, { now: NOW });
    expect(page?.account).toEqual({
      publicId: zezima.publicId,
      name: 'Zezima',
      accountType: 1,
      firstSeen: '2025-01-01T00:00:00.000Z',
      lastSeen: ago(30_000).toISOString(),
      previousNames: [
        { name: 'Old Zez', lastSeen: '2026-06-01T00:00:00.000Z' },
        { name: 'Older Zez', lastSeen: '2026-01-01T00:00:00.000Z' },
      ],
      owner: { userId: owner.id, name: 'Owner', image: 'https://cdn.example/owner.png' },
      relation: 'owner',
      canManage: true,
      hidden: false,
    });
  });

  it('withholds last seen from viewers without activity', async () => {
    const page = await getAccountPage(t.db, member.viewer, quiet.publicId, { now: NOW });
    expect(page?.account.lastSeen).toBeNull();
    expect(page?.presence).toEqual({ visible: false });
    expect(page?.vitals).toEqual({ visible: false });
  });

  it('has no owner for an unclaimed account', async () => {
    const page = await getAccountPage(t.db, member.viewer, ownerless.publicId, { now: NOW });
    expect(page?.account.owner).toBeNull();
    expect(page?.presence).toEqual({ visible: true, shared: false });
  });

  it('is null for unknown or absurd public ids', async () => {
    expect(await getAccountPage(t.db, owner.viewer, 'nope', { now: NOW })).toBeNull();
    expect(await getAccountPage(t.db, owner.viewer, 'x'.repeat(500), { now: NOW })).toBeNull();
  });
});

describe('getAccountPage sections', () => {
  let page: AccountPage;

  beforeAll(async () => {
    const p = await getAccountPage(t.db, owner.viewer, zezima.publicId, {
      now: NOW,
      timezone: 'Europe/Amsterdam',
    });
    if (!p) throw new Error('page missing');
    page = p;
  });

  it('shows presence per the presence rules', () => {
    expect(page.presence).toEqual({
      visible: true,
      shared: true,
      updatedAt: ago(30_000).toISOString(),
      data: {
        online: true,
        world: 302,
        specialWorld: false,
        gameState: 'LOGGED_IN',
        lastSeen: ago(30_000).toISOString(),
      },
    });
  });

  it('shows the vitals that were sent, stamped with the latest update', () => {
    expect(page.vitals).toEqual({
      visible: true,
      shared: true,
      updatedAt: ago(30_000).toISOString(),
      data: { hp: { current: 95, max: 99 }, prayer: null, spellbook: 'lunar' },
    });
  });

  it('marks a location older than two minutes stale', async () => {
    expect(data(page.location)).toEqual({
      x: 3164,
      y: 3487,
      plane: 1,
      isOnBoat: true,
      stale: true,
    });
    const quietPage = await getAccountPage(t.db, owner.viewer, quiet.publicId, { now: NOW });
    expect(quietPage && data(quietPage.location)).toEqual({
      x: 1,
      y: 2,
      plane: 0,
      isOnBoat: false,
      stale: false,
    });
  });

  it('flags a special world in presence', async () => {
    const quietPage = await getAccountPage(t.db, owner.viewer, quiet.publicId, { now: NOW });
    expect(quietPage && data(quietPage.presence)).toMatchObject({
      online: true,
      world: 330,
      specialWorld: true,
    });
  });

  it('lists skills in grid order with Overall first and real levels (PLUGIN-9, D-44)', () => {
    const skills = data(page.skills);
    expect(skills.rows.map((r) => r.skill)).toEqual([
      'Overall',
      'Attack',
      'Hitpoints',
      'Mining',
      'Newskill',
    ]);
    // 99 (Attack is virtual 108) + 99 + 1 + 2.
    expect(skills.totalLevel).toBe(201);
    expect(skills.overallXp).toBe(34_512_847 + 13_034_431 + 0 + 100);
    expect(skills.rows[0]).toMatchObject({ level: 201, realLevel: 201, xp: skills.overallXp });
    expect(skills.rows[1]).toMatchObject({ skill: 'Attack', level: 108, realLevel: 99 });
  });

  it('computes gains per period in the viewer time zone', async () => {
    const attack = data(page.skills).rows.find((r) => r.skill === 'Attack');
    expect(attack?.gains).toEqual({
      // Amsterdam midnight is 22:00Z: the 21:55 bucket (34.4M) is the last one before it.
      day: 34_512_847 - 34_400_000,
      // Week starts 2026-09-21T12:00: the 09-01 sample; month starts 08-29: the 01-01 sample.
      week: 34_512_847 - 33_000_000,
      month: 34_512_847 - 30_000_000,
      year: 34_512_847 - 20_000_000,
    });
    const utc = await getAccountPage(t.db, owner.viewer, zezima.publicId, { now: NOW });
    const utcAttack = utc && data(utc.skills).rows.find((r) => r.skill === 'Attack');
    expect(utcAttack?.gains.day).toBe(34_512_847 - 34_450_000);
    const hp = data(page.skills).rows.find((r) => r.skill === 'Hitpoints');
    expect(hp?.gains).toEqual({ day: 0, week: 0, month: 0, year: 0 });
  });

  it('returns equipment and inventory with its value', () => {
    expect(data(page.equipment).items).toHaveLength(1);
    expect(page.equipment).toMatchObject({ updatedAt: ago(45_000).toISOString() });
    expect(data(page.inventory)).toMatchObject({ value: 900 + 900 + 25_000 });
    expect(data(page.inventory).items).toHaveLength(3);
  });

  it('returns the newest events, newest first', () => {
    const events = data(page.recentEvents);
    expect(events).toHaveLength(PAGE_EVENTS);
    expect(events.map((e) => e.seq)).toEqual(eventSeqs.slice(-PAGE_EVENTS).reverse());
    expect(events[0]).toMatchObject({
      type: 'level_up',
      account: { publicId: zezima.publicId, name: 'Zezima' },
    });
    expect(page.recentEvents).toMatchObject({ updatedAt: events[0]?.receivedAt });
  });
});
