/**
 * GET /accounts/{id}/progress and GET /leaderboards/kills (D-139): the Progress page and the guild's
 * boss leaderboards as read models, through a key. Each section follows its category on the key, a
 * key's narrower categories win over the creator's own access, and the range checks.
 */
import { accountHiscores, activityScores, playSessions, wealthDaily } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setGoal } from '../account-metrics';
import {
  seedAccount,
  seedEvent,
  seedLatestState,
  seedUser,
  seedXp,
  skillMap,
  type SeededAccount,
  type SeededUser,
} from '../accounts/test-support';
import { ApiError } from './errors';
import { apiKillsLeaderboard } from './leaderboards';
import { apiProgress, progressQuery } from './progress';
import { makeKey, present, type TestKey } from './test-support';

const NOW = new Date('2026-10-09T12:00:00Z');
const MIN = 60_000;
const at = (iso: string) => new Date(iso);

let t: TestDatabase;
let owner: SeededUser;
let member: SeededUser;
let mira: SeededAccount;
let rival: SeededAccount;
let ownerKey: TestKey;
let statsKey: TestKey;
let liveKey: TestKey;

beforeAll(async () => {
  t = await createTestDatabase('api-progress');
  owner = await seedUser(t.db);
  member = await seedUser(t.db);
  mira = await seedAccount(t.db, { owner: owner.id, name: 'Metric Mira' });
  rival = await seedAccount(t.db, { owner: member.id, name: 'Rival' });

  // One session on Monday 5 October, 18:00–19:00: Ranged for ten minutes, a Zulrah drop at 18:31.
  await t.db.insert(playSessions).values({
    accountId: mira.id,
    startedAt: at('2026-10-05T18:00:00Z'),
    lastSeenAt: at('2026-10-05T19:00:00Z'),
    endedAt: at('2026-10-05T19:00:00Z'),
    endReason: 'logout',
  });
  await seedXp(t.db, mira.id, [
    ['Ranged', '2026-08-01T00:00:00Z', 1_000_000],
    ['Ranged', '2026-10-05T18:00:00Z', 1_010_000],
    ['Ranged', '2026-10-05T18:05:00Z', 1_020_000],
    ['Ranged', '2026-10-05T18:10:00Z', 1_030_000],
    // Overall is its own row, as ingest stores it; the current one is the sum of the skills.
    ['Overall', '2026-08-01T00:00:00Z', 1_000_000],
    ['Overall', '2026-10-05T18:00:00Z', 1_010_000],
    ['Overall', '2026-10-05T18:05:00Z', 1_020_000],
    ['Overall', '2026-10-05T18:10:00Z', 1_030_000],
  ]);
  await seedLatestState(t.db, mira.id, {
    lastSeen: at('2026-10-05T19:00:00Z'),
    skills: skillMap({ Ranged: [1_030_000, 73] }),
    skillsUpdatedAt: at('2026-10-05T19:00:00Z'),
  });
  await seedEvent(t.db, mira.id, {
    type: 'loot',
    occurredAt: at('2026-10-05T18:31:00Z'),
    valueGp: 2_000_000,
    data: { type: 'loot', data: { source: { text: 'Zulrah' } }, eventId: 'z', timestamp: 0 },
  });

  // Hiscores: a baseline (lifetime 130 never counts), then +20 after the session. Rival: +30.
  await t.db.insert(activityScores).values([
    {
      accountId: mira.id,
      activity: 'Zulrah',
      readAt: at('2026-10-01T10:00:00Z'),
      score: 130,
      baseline: true,
    },
    {
      accountId: mira.id,
      activity: 'Zulrah',
      readAt: at('2026-10-05T19:10:00Z'),
      score: 150,
      baseline: false,
    },
    {
      accountId: rival.id,
      activity: 'Zulrah',
      readAt: at('2026-09-20T10:00:00Z'),
      score: 10,
      baseline: true,
    },
    {
      accountId: rival.id,
      activity: 'Zulrah',
      readAt: at('2026-10-08T10:00:00Z'),
      score: 40,
      baseline: false,
    },
    {
      accountId: rival.id,
      activity: 'Vorkath',
      readAt: at('2026-09-20T10:00:00Z'),
      score: 5,
      baseline: true,
    },
    {
      accountId: rival.id,
      activity: 'Vorkath',
      readAt: at('2026-09-25T10:00:00Z'),
      score: 9,
      baseline: false,
    },
  ]);
  await t.db.insert(accountHiscores).values({
    accountId: mira.id,
    lookupName: 'Metric Mira',
    mode: 'regular',
    status: 'ok',
    lastAttemptAt: at('2026-10-05T19:10:00Z'),
    fetchedAt: at('2026-10-05T19:10:00Z'),
    main: {
      skills: [{ name: 'Overall', rank: 10, level: 140, xp: 1_530_000 }],
      activities: [{ name: 'Zulrah', rank: 500, score: 150 }],
    },
  });
  await t.db.insert(wealthDaily).values([
    { accountId: mira.id, day: '2026-09-01', lastValue: 1_000, maxValue: 1_000 },
    { accountId: mira.id, day: '2026-10-08', lastValue: 5_000, maxValue: 6_000 },
  ]);
  await setGoal(t.db, owner.viewer, mira.publicId, { kind: 'level', target: 'Ranged', value: 80 });

  ownerKey = await makeKey(t.db, owner.id, { name: 'owner' }, NOW);
  statsKey = await makeKey(t.db, owner.id, { name: 'stats', categories: ['stats'] }, NOW);
  liveKey = await makeKey(t.db, owner.id, { name: 'live', categories: ['location_live'] }, NOW);
});

afterAll(() => t.drop());

describe('progressQuery', () => {
  it('takes a preset or a custom range, never both', () => {
    expect(progressQuery({})).toEqual({ range: '7d', from: null, to: null });
    expect(progressQuery({ range: '30d' })).toMatchObject({ range: '30d' });
    expect(progressQuery({ from: '2026-10-01', to: '2026-10-07' })).toEqual({
      range: 'custom',
      from: '2026-10-01',
      to: '2026-10-07',
    });
    for (const bad of [
      { range: '2w' },
      { range: '7d', from: '2026-10-01', to: '2026-10-02' },
      { from: '2026-10-01' },
      { from: 'yesterday', to: '2026-10-02' },
      { from: '2026-10-05', to: '2026-10-01' },
    ] as const) {
      expect(() => progressQuery(bad as never), JSON.stringify(bad)).toThrow(ApiError);
    }
  });
});

describe('apiProgress', () => {
  it('answers the Progress page: playtime, XP, loot, kills, wealth and goals', async () => {
    const p = present(await apiProgress(t.db, ownerKey.principal, mira.publicId, {}, NOW));
    expect(p).toMatchObject({
      account: { id: mira.publicId, name: 'Metric Mira' },
      timezone: 'UTC',
      range: '7d',
      from: '2026-10-02T12:00:00.000Z',
      to: NOW.toISOString(),
    });
    expect(p.playtime).toMatchObject({ sessions: 1, onlineMs: 60 * MIN, longestMs: 60 * MIN });
    expect(p.playtime!.activeMs).toBeGreaterThan(0);
    expect(p.playtime!.activeMs).toBeLessThanOrEqual(60 * MIN);
    expect(p.playtime!.days.map((d) => d.date)).toEqual(['2026-10-05']);
    const total = p.playtime!.activities.reduce((s, a) => s + a.ms, 0);
    expect(total).toBe(p.playtime!.activeMs);
    expect(p.xp?.gained).toBe(30_000);
    expect(p.xp?.skills[0]).toMatchObject({ skill: 'Ranged', level: 73, gained: 30_000 });
    expect(p.loot).toEqual({ gp: 2_000_000, drops: 1 });
    expect(p.bosses).toMatchObject({
      kills: 20,
      readAt: '2026-10-05T19:10:00.000Z',
      list: [{ boss: 'Zulrah', killCount: 150, gained: 20, rank: 500, gp: 2_000_000 }],
    });
    expect(p.wealth).toEqual({ change: 4_000 });
    expect(p.goals).toEqual([
      expect.objectContaining({ kind: 'level', target: 'Ranged', value: 80, current: 73 }),
    ]);
  });

  it("follows the key's categories, not its creator's access", async () => {
    const p = present(await apiProgress(t.db, statsKey.principal, mira.publicId, {}, NOW));
    expect(p.xp).toBeDefined();
    for (const section of ['playtime', 'loot', 'bosses', 'wealth'] as const) {
      expect(p, section).not.toHaveProperty(section);
    }
    expect(await apiProgress(t.db, liveKey.principal, mira.publicId, {}, NOW)).toBeNull();
    expect(await apiProgress(t.db, ownerKey.principal, 'Zz9Zz9Zz9Zz9', {}, NOW)).toBeNull();
  });

  it('reads a custom range of dates', async () => {
    const p = present(
      await apiProgress(
        t.db,
        ownerKey.principal,
        mira.publicId,
        { from: '2026-10-06', to: '2026-10-07' },
        NOW,
      ),
    );
    expect(p).toMatchObject({ range: 'custom', from: '2026-10-06T00:00:00.000Z' });
    expect(p.playtime?.sessions).toBe(0);
    expect(p.xp?.gained).toBe(0);
  });
});

describe('apiKillsLeaderboard', () => {
  it('ranks kills gained per boss over the key’s accounts, never a baseline', async () => {
    const week = await apiKillsLeaderboard(t.db, ownerKey.principal, {}, NOW);
    expect(week.period).toBe('week');
    expect(week.leaderboards).toEqual([
      {
        boss: 'Zulrah',
        entries: [
          { rank: 1, account: { id: rival.publicId, name: 'Rival' }, kills: 30 },
          { rank: 2, account: { id: mira.publicId, name: 'Metric Mira' }, kills: 20 },
        ],
      },
    ]);
    const month = await apiKillsLeaderboard(
      t.db,
      ownerKey.principal,
      { period: 'month', boss: 'vorkath' },
      NOW,
    );
    expect(month.leaderboards).toEqual([
      {
        boss: 'Vorkath',
        entries: [{ rank: 1, account: { id: rival.publicId, name: 'Rival' }, kills: 4 }],
      },
    ]);
    const none = await apiKillsLeaderboard(t.db, ownerKey.principal, { boss: 'Jad' }, NOW);
    expect(none.leaderboards).toEqual([{ boss: 'Jad', entries: [] }]);
  });

  it('is empty for a key without hiscores, and refuses a bad period', async () => {
    expect((await apiKillsLeaderboard(t.db, statsKey.principal, {}, NOW)).leaderboards).toEqual([]);
    await expect(
      apiKillsLeaderboard(t.db, ownerKey.principal, { period: 'day' as never }, NOW),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
