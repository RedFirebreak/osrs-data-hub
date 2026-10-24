import { accountHiscores, activityScores } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  seedAccount,
  seedEvent,
  seedSharing,
  seedUser,
  type SeededAccount,
  type SeededUser,
} from '../accounts/test-support';
import { getAccountCollectionLog, groupBySource } from './account';
import { getGuildCollectionLog, lookupQuery } from './guild';

const NOW = new Date('2026-10-24T12:00:00Z');
const at = (iso: string) => new Date(iso);

let t: TestDatabase;
let owner: SeededUser;
let member: SeededUser;
let mira: SeededAccount;
let rival: SeededAccount;

function clog(
  account: SeededAccount,
  iso: string,
  item: string,
  extra: Record<string, unknown> = {},
) {
  const {
    itemId = 1,
    killCount,
    special = false,
  } = extra as {
    itemId?: number | null;
    killCount?: number;
    special?: boolean;
  };
  return seedEvent(t.db, account.id, {
    type: 'collection_log',
    occurredAt: at(iso),
    itemId,
    valueGp: 1000,
    specialWorld: special,
    data: {
      type: 'collectionLog',
      data: { itemName: item, itemId: itemId ?? -1, value: 1000, killCount },
      eventId: `${account.id}-${iso}`,
      timestamp: 0,
    },
  });
}

function loot(account: SeededAccount, iso: string, source: string) {
  return seedEvent(t.db, account.id, {
    type: 'loot',
    occurredAt: at(iso),
    valueGp: 5000,
    data: { type: 'loot', data: { source: { text: source } }, eventId: `l-${iso}`, timestamp: 0 },
  });
}

async function hiscores(account: SeededAccount, score: number) {
  await t.db.insert(accountHiscores).values({
    accountId: account.id,
    lookupName: account.name,
    mode: 'regular',
    status: 'ok',
    lastAttemptAt: at('2026-10-24T10:00:00Z'),
    fetchedAt: at('2026-10-24T10:00:00Z'),
    main: {
      skills: [{ name: 'Overall', rank: 10, level: 1500, xp: 50_000_000 }],
      activities: [{ name: 'Collections Logged', rank: 4321, score }],
    },
  });
}

beforeAll(async () => {
  t = await createTestDatabase('collection-log');
  owner = await seedUser(t.db);
  member = await seedUser(t.db);
  mira = await seedAccount(t.db, { owner: owner.id, name: 'Clog Mira' });
  rival = await seedAccount(t.db, { owner: member.id, name: 'Rival' });

  await loot(mira, '2026-10-20T18:00:00Z', 'Zulrah');
  await clog(mira, '2026-10-20T18:00:02Z', 'Tanzanite fang', { itemId: 12922, killCount: 212 });
  await loot(mira, '2026-10-21T18:00:00Z', 'Zulrah');
  await clog(mira, '2026-10-21T18:00:03Z', 'Magic fang', { itemId: 12932, killCount: 260 });
  // A pet comes without a loot drop; an unresolved name has no item id.
  await clog(mira, '2026-10-22T09:00:00Z', 'Pet snakeling', { itemId: 12921 });
  await clog(mira, '2026-10-22T09:30:00Z', 'Abyssal protector', { itemId: null });
  // Sent twice: listed once, at the first time.
  await clog(mira, '2026-10-23T09:00:00Z', 'Tanzanite FANG', { itemId: 12922 });
  // Leagues keep a log of their own.
  await clog(mira, '2026-10-23T10:00:00Z', 'Dragon pickaxe', { special: true });

  await loot(rival, '2026-10-19T20:00:00Z', 'Zulrah');
  await clog(rival, '2026-10-19T20:00:01Z', 'Tanzanite fang', { itemId: 12922, killCount: 90 });

  await hiscores(mira, 512);
  await hiscores(rival, 800);
  await t.db.insert(activityScores).values([
    {
      accountId: mira.id,
      activity: 'Collections Logged',
      readAt: at('2026-10-01T10:00:00Z'),
      score: 400,
      baseline: true,
    },
    {
      accountId: mira.id,
      activity: 'Collections Logged',
      readAt: at('2026-10-24T10:00:00Z'),
      score: 512,
      baseline: false,
    },
  ]);
});

afterAll(async () => {
  await t?.drop();
});

describe('getAccountCollectionLog', () => {
  it('gives the hiscores total and the slots seen, grouped by the drop they came with', async () => {
    const page = (await getAccountCollectionLog(t.db, member.viewer, mira.publicId, { now: NOW }))!;
    expect(page.total).toMatchObject({ score: 512, rank: 4321, mode: 'regular', gained30: 112 });
    expect(page.slots!.map((s) => s.item)).toEqual([
      'Abyssal protector',
      'Pet snakeling',
      'Magic fang',
      'Tanzanite fang',
    ]);
    expect(page.slots![3]).toEqual({
      itemId: 12922,
      item: 'Tanzanite fang',
      killCount: 212,
      value: 1000,
      at: '2026-10-20T18:00:02.000Z',
      source: 'Zulrah',
    });
    expect(page.slots![0]!.itemId).toBeNull();
    expect(page.groups!.map((g) => [g.source, g.slots.length])).toEqual([
      ['Zulrah', 2],
      [null, 2],
    ]);
  });

  it('leaves out what is not shared, and is null when neither is', async () => {
    await seedSharing(t.db, mira.id, 'events', 'private');
    const page = (await getAccountCollectionLog(t.db, member.viewer, mira.publicId, { now: NOW }))!;
    expect(page.slots).toBeNull();
    expect(page.groups).toBeNull();
    expect(page.total?.score).toBe(512);
    // The owner sees everything.
    expect(
      (await getAccountCollectionLog(t.db, owner.viewer, mira.publicId, { now: NOW }))!.slots,
    ).toHaveLength(4);

    await seedSharing(t.db, mira.id, 'hiscores', 'private');
    expect(
      await getAccountCollectionLog(t.db, member.viewer, mira.publicId, { now: NOW }),
    ).toBeNull();
    await seedSharing(t.db, mira.id, 'events', 'guild');
    const slotsOnly = (await getAccountCollectionLog(t.db, member.viewer, mira.publicId, {
      now: NOW,
    }))!;
    expect(slotsOnly.total).toBeNull();
    expect(slotsOnly.slots).toHaveLength(4);
    await seedSharing(t.db, mira.id, 'hiscores', 'guild');
  });
});

describe('getGuildCollectionLog', () => {
  it('ranks by the hiscores count, with the 30-day rise and the slots seen', async () => {
    const guild = await getGuildCollectionLog(t.db, member.viewer, { now: NOW });
    expect(guild.board.map((r) => [r.name, r.logged, r.gained30, r.seen])).toEqual([
      ['Rival', 800, 0, 1],
      ['Clog Mira', 512, 112, 4],
    ]);
    expect(guild.board[1]!.latest).toMatchObject({ item: 'Abyssal protector' });
    expect(guild.recent[0]).toMatchObject({
      item: 'Abyssal protector',
      account: { name: 'Clog Mira' },
    });
    expect(guild.recent).toHaveLength(5);
    expect(guild.searchable).toBe(2);
    expect(guild.lookup).toBeNull();
  });

  it('answers who has an item, first logged first', async () => {
    const guild = await getGuildCollectionLog(t.db, member.viewer, { now: NOW, query: ' fang ' });
    expect(guild.lookup!.query).toBe('fang');
    expect(guild.lookup!.items.map((i) => [i.item, i.holders.map((h) => h.name)])).toEqual([
      ['Tanzanite fang', ['Rival', 'Clog Mira']],
      ['Magic fang', ['Clog Mira']],
    ]);
    expect(guild.lookup!.items[0]!.holders[1]).toMatchObject({ killCount: 212 });
  });

  it('takes % and _ literally', async () => {
    const guild = await getGuildCollectionLog(t.db, member.viewer, { now: NOW, query: '%%' });
    expect(guild.lookup!.items).toEqual([]);
  });

  it('never lists an account whose events are private, nor one hidden from the guild', async () => {
    await seedSharing(t.db, rival.id, 'events', 'private');
    const guild = await getGuildCollectionLog(t.db, owner.viewer, { now: NOW, query: 'fang' });
    expect(guild.lookup!.items[0]!.holders.map((h) => h.name)).toEqual(['Clog Mira']);
    expect(guild.board.find((r) => r.name === 'Rival')).toMatchObject({ logged: 800, seen: null });
    await seedSharing(t.db, rival.id, 'events', 'guild');

    const hidden = await seedAccount(t.db, {
      owner: member.id,
      name: 'Hidden',
      hiddenFromGuild: true,
    });
    await clog(hidden, '2026-10-22T12:00:00Z', 'Tanzanite fang');
    const again = await getGuildCollectionLog(t.db, member.viewer, { now: NOW, query: 'fang' });
    expect(again.board.map((r) => r.name)).not.toContain('Hidden');
    expect(again.lookup!.items[0]!.holders.map((h) => h.name)).not.toContain('Hidden');
  });
});

describe('lookupQuery', () => {
  it('trims, folds spaces, and needs two characters', () => {
    expect(lookupQuery('  a  ')).toBeNull();
    expect(lookupQuery(' dragon   pickaxe ')).toBe('dragon pickaxe');
    expect(lookupQuery(['x'])).toBeNull();
    expect(lookupQuery('x'.repeat(100))).toHaveLength(64);
  });
});

describe('groupBySource', () => {
  it('puts the biggest source first and the slots without one last', () => {
    const slot = (item: string, source: string | null, iso: string) => ({
      itemId: 1,
      item,
      killCount: null,
      value: null,
      at: iso,
      source,
    });
    expect(
      groupBySource([
        slot('c', null, '2026-10-03'),
        slot('b', 'Vorkath', '2026-10-02'),
        slot('a', 'Zulrah', '2026-10-01'),
      ]).map((g) => g.source),
    ).toEqual(['Vorkath', 'Zulrah', null]);
  });
});
