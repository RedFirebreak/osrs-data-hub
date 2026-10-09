import { CATEGORIES } from '@hub/core';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEADERBOARD_SIZE, getGuildOverview } from './guild';
import {
  seedAccount,
  seedEvent,
  seedGrant,
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
const online = { lastSeen: new Date(NOW.getTime() - 30_000), gameState: 'LOGGED_IN' };

let t: TestDatabase;
let viewer: SeededUser;
let alice: SeededUser;
let bob: SeededUser;
let zulu: SeededAccount;
let yankee: SeededAccount;
let xray: SeededAccount;
let whiskey: SeededAccount;
let zuluEvents: number[];
let victorEvent: number;

async function withSkills(
  account: SeededAccount,
  skills: Record<string, [number, number]>,
  state: Partial<typeof online> = {},
) {
  await seedLatestState(t.db, account.id, {
    lastSeen: new Date('2026-09-28T09:00:00Z'),
    ...state,
    skills: skillMap(skills),
    skillsUpdatedAt: NOW,
  });
}

beforeAll(async () => {
  t = await createTestDatabase('accounts-guild');
  viewer = await seedUser(t.db, { name: 'Viewer' });
  alice = await seedUser(t.db, { name: 'alice', image: 'https://cdn.example/a.png' });
  bob = await seedUser(t.db, { name: 'Bob' });
  const gina = await seedUser(t.db, { name: 'Gina', status: 'grace' });
  const carl = await seedUser(t.db, { name: 'Carl' });
  await seedUser(t.db, { name: 'Nobody' });

  zulu = await seedAccount(t.db, { name: 'Zulu', owner: alice.id, contributors: [bob.id] });
  await withSkills(zulu, { Attack: [5000, 40] }, online);
  await seedXp(t.db, zulu.id, [
    ['Attack', '2026-09-01T10:00:00Z', 1000],
    ['Attack', '2026-09-25T10:00:00Z', 3000],
    ['Attack', '2026-09-28T05:00:00Z', 4000],
    ['Overall', '2026-09-01T10:00:00Z', 1000],
    ['Overall', '2026-09-25T10:00:00Z', 3000],
    ['Overall', '2026-09-28T05:00:00Z', 4000],
  ]);
  zuluEvents = [
    (await seedEvent(t.db, zulu.id, { type: 'loot' })).seq,
    (await seedEvent(t.db, zulu.id, { type: 'level_up' })).seq,
  ];

  yankee = await seedAccount(t.db, { name: 'Yankee', owner: bob.id });
  await seedSharing(t.db, yankee.id, 'activity', 'private');
  await withSkills(yankee, { Attack: [2500, 30] }, online);
  await seedXp(t.db, yankee.id, [
    ['Attack', '2026-08-01T10:00:00Z', 500],
    ['Attack', '2026-09-27T10:00:00Z', 2000],
    ['Overall', '2026-08-01T10:00:00Z', 500],
    ['Overall', '2026-09-27T10:00:00Z', 2000],
  ]);

  // Owner in grace but not hidden (yet): visible, on the leaderboards, but Gina isn't a member.
  xray = await seedAccount(t.db, { name: 'Xray', owner: gina.id });
  await withSkills(xray, { Mining: [900, 20] });
  await seedXp(t.db, xray.id, [
    ['Mining', '2026-09-28T01:00:00Z', 100],
    ['Overall', '2026-09-28T01:00:00Z', 100],
  ]);

  // No gains; Carl is blocked on it.
  whiskey = await seedAccount(t.db, { name: 'Whiskey', owner: alice.id });
  await seedLink(t.db, whiskey.id, carl.id, { blocked: true });
  await withSkills(whiskey, { Attack: [10, 1] });
  await seedXp(t.db, whiskey.id, [['Attack', '2026-01-01T00:00:00Z', 10]]);

  // Nothing shared with the guild: invisible, however big its gains.
  const uniform = await seedAccount(t.db, { name: 'Uniform', owner: bob.id });
  for (const c of CATEGORIES) await seedSharing(t.db, uniform.id, c, 'private');
  await withSkills(uniform, { Attack: [1e9, 99] });
  await seedXp(t.db, uniform.id, [['Attack', '2026-09-28T01:00:00Z', 1]]);
  await seedEvent(t.db, uniform.id, { type: 'loot' });

  const hidden = await seedAccount(t.db, { name: 'Hidden', owner: alice.id, status: 'hidden' });
  await seedEvent(t.db, hidden.id, { type: 'loot' });

  // Hidden from the guild by its owner (D-104), shared with the guild and granted to the viewer
  // anyway: only alice and her contributor Bob see it, however big its gains.
  const victor = await seedAccount(t.db, {
    name: 'Victor',
    owner: alice.id,
    contributors: [bob.id],
    hiddenFromGuild: true,
  });
  for (const c of CATEGORIES) {
    await seedSharing(t.db, victor.id, c, 'guild');
    await seedGrant(t.db, victor.id, c, viewer.id);
  }
  await withSkills(victor, { Attack: [1e9, 99] }, online);
  await seedXp(t.db, victor.id, [['Attack', '2026-09-28T01:00:00Z', 1]]);
  victorEvent = (await seedEvent(t.db, victor.id, { type: 'loot' })).seq;

  // Twelve fishers for the top-10 cut.
  for (let i = 1; i <= 12; i++) {
    const fisher = await seedAccount(t.db, {
      name: `Fish${String(i).padStart(2, '0')}`,
      owner: bob.id,
    });
    await withSkills(fisher, { Fishing: [i * 100, 10] });
    await seedXp(t.db, fisher.id, [['Fishing', '2026-09-27T10:00:00Z', 0]]);
  }
});

afterAll(async () => {
  await t.drop();
});

describe('getGuildOverview', () => {
  it('lists active members with their visible accounts, each under its owner', async () => {
    const guild = await getGuildOverview(t.db, viewer.viewer, { now: NOW });
    // Zulu is alice's; Bob contributes to it, which a plain member must not learn (D-68).
    expect(guild.members.map((m) => [m.name, m.accounts.map((a) => a.name)])).toEqual([
      ['alice', ['Whiskey', 'Zulu']],
      [
        'Bob',
        [
          ...Array.from({ length: 12 }, (_, i) => `Fish${String(i + 1).padStart(2, '0')}`),
          'Yankee',
        ],
      ],
    ]);
    expect(guild.members[0]).toMatchObject({
      userId: alice.id,
      image: 'https://cdn.example/a.png',
    });
  });

  it('lists contributors only to those who may read them in the sharing settings (D-68)', async () => {
    const shared = (guild: Awaited<ReturnType<typeof getGuildOverview>>) =>
      guild.members.filter((m) => m.accounts.some((a) => a.name === 'Zulu')).map((m) => m.name);
    // The owner and the contributor see both players; so does an admin.
    expect(shared(await getGuildOverview(t.db, alice.viewer, { now: NOW }))).toEqual([
      'alice',
      'Bob',
    ]);
    expect(shared(await getGuildOverview(t.db, bob.viewer, { now: NOW }))).toEqual([
      'alice',
      'Bob',
    ]);
    expect(
      shared(await getGuildOverview(t.db, { ...viewer.viewer, isAdmin: true }, { now: NOW })),
    ).toEqual(['alice', 'Bob']);
    // A plain member sees the owner only.
    expect(shared(await getGuildOverview(t.db, viewer.viewer, { now: NOW }))).toEqual(['alice']);
  });

  it('shows online only where the viewer may see activity', async () => {
    const guild = await getGuildOverview(t.db, viewer.viewer, { now: NOW });
    const alices = guild.members.find((m) => m.name === 'alice')?.accounts ?? [];
    const bobs = guild.members.find((m) => m.name === 'Bob')?.accounts ?? [];
    expect(alices.find((a) => a.name === 'Zulu')?.online).toBe(true);
    expect(bobs.find((a) => a.name === 'Yankee')?.online).toBe(false);
    const asBob = await getGuildOverview(t.db, bob.viewer, { now: NOW });
    const own = asBob.members.find((m) => m.name === 'Bob')?.accounts ?? [];
    expect(own.find((a) => a.name === 'Yankee')?.online).toBe(true);
    expect(own.map((a) => a.name)).toContain('Uniform');
  });

  it('has the visible events, newest first', async () => {
    const guild = await getGuildOverview(t.db, viewer.viewer, { now: NOW });
    expect(guild.feed.map((e) => e.seq)).toEqual([...zuluEvents].reverse());
  });

  it('ranks daily gains: Overall first, skills in grid order, top 10, no zero gains', async () => {
    const { leaderboards } = await getGuildOverview(t.db, viewer.viewer, { now: NOW });
    expect(leaderboards.day.map((b) => b.skill)).toEqual([
      'Overall',
      'Attack',
      'Mining',
      'Fishing',
    ]);
    const board = (skill: string) => leaderboards.day.find((b) => b.skill === skill)?.entries;
    expect(board('Overall')).toEqual([
      // xp_at(UTC midnight) is the 09-25 sample (3000); the 05:00 one is today's.
      { publicId: zulu.publicId, name: 'Zulu', gain: 2000 },
      { publicId: xray.publicId, name: 'Xray', gain: 800 },
      { publicId: yankee.publicId, name: 'Yankee', gain: 500 },
    ]);
    expect(board('Attack')?.map((e) => [e.name, e.gain])).toEqual([
      ['Zulu', 2000],
      ['Yankee', 500],
    ]);
    const fishing = board('Fishing') ?? [];
    expect(fishing).toHaveLength(LEADERBOARD_SIZE);
    expect(fishing.map((e) => e.gain)).toEqual([
      1200, 1100, 1000, 900, 800, 700, 600, 500, 400, 300,
    ]);
  });

  it('ranks weekly and monthly gains', async () => {
    const { leaderboards } = await getGuildOverview(t.db, viewer.viewer, { now: NOW });
    const overall = (period: 'week' | 'month') =>
      leaderboards[period].find((b) => b.skill === 'Overall')?.entries.map((e) => [e.name, e.gain]);
    // Week from 09-21 12:00: Zulu's baseline is 09-01 (1000), Yankee's 08-01 (500).
    expect(overall('week')).toEqual([
      ['Zulu', 4000],
      ['Yankee', 2000],
      ['Xray', 800],
    ]);
    // Month from 08-29 12:00: Zulu has no sample before, so its first (1000) is the baseline.
    expect(overall('month')).toEqual([
      ['Zulu', 4000],
      ['Yankee', 2000],
      ['Xray', 800],
    ]);
  });

  it('shows an account hidden from the guild to its players only (D-104)', async () => {
    const names = (guild: Awaited<ReturnType<typeof getGuildOverview>>) =>
      guild.members.flatMap((m) => m.accounts.map((a) => a.name));
    const attack = (guild: Awaited<ReturnType<typeof getGuildOverview>>) =>
      guild.leaderboards.day.find((b) => b.skill === 'Attack')?.entries.map((e) => e.name);

    for (const player of [alice, bob]) {
      const guild = await getGuildOverview(t.db, player.viewer, { now: NOW });
      expect(names(guild)).toContain('Victor');
      expect(guild.feed.map((e) => e.seq)).toContain(victorEvent);
      expect(attack(guild)).toContain('Victor');
    }

    const asMember = await getGuildOverview(t.db, viewer.viewer, { now: NOW });
    expect(names(asMember)).not.toContain('Victor');
    expect(asMember.feed.map((e) => e.seq)).not.toContain(victorEvent);
    expect(attack(asMember)).toEqual(['Zulu', 'Yankee']);
  });

  it("doesn't list an account to an admin who sees it only through the override", async () => {
    const asAdmin = await getGuildOverview(t.db, { ...viewer.viewer, isAdmin: true }, { now: NOW });
    const names = asAdmin.members.flatMap((m) => m.accounts.map((a) => a.name));
    // Hidden from the guild, and every category private: nothing of either is the admin's to read.
    expect(names).not.toContain('Victor');
    expect(names).not.toContain('Uniform');
    // What the guild sees stays listed, and so does an account hidden while its owner is in grace,
    // whose data an admin may read (the account is shared with the guild).
    expect(names).toEqual(expect.arrayContaining(['Zulu', 'Yankee', 'Whiskey', 'Hidden']));
    expect(asAdmin.feed.map((e) => e.seq)).not.toContain(victorEvent);
  });

  it('cuts the day at local midnight', async () => {
    // Kiritimati (+14): midnight was 2026-09-28T10:00Z, after Zulu's 05:00 sample (4000).
    const { leaderboards } = await getGuildOverview(t.db, viewer.viewer, {
      now: NOW,
      timezone: 'Pacific/Kiritimati',
    });
    const attack = leaderboards.day.find((b) => b.skill === 'Attack')?.entries;
    expect(attack?.map((e) => [e.name, e.gain])).toEqual([
      ['Zulu', 1000],
      ['Yankee', 500],
    ]);
  });
});
