import { DEFAULT_METRICS_QUERY, type MetricsQuery } from '@hub/core';
import {
  accountHiscores,
  activityScores,
  hiscoreXpFills,
  playSessions,
  wealthDaily,
} from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  seedAccount,
  seedEvent,
  seedLatestState,
  seedSharing,
  seedUser,
  seedXp,
  skillId,
  skillMap,
  type SeededAccount,
  type SeededUser,
} from '../accounts/test-support';
import { getAccountMetrics } from './account';
import { getBossMetrics } from './boss';
import { GoalError, deleteGoal, setGoal } from './goals';
import { getBossLeaderboards } from './leaderboards';
import { resolveMetricsRange, startOfLocalDate } from './range';

const NOW = new Date('2026-10-09T12:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (iso: string) => new Date(iso);
const OPTS = { now: NOW, timezone: 'UTC' };
const query = (q: Partial<MetricsQuery> = {}): MetricsQuery => ({ ...DEFAULT_METRICS_QUERY, ...q });

let t: TestDatabase;
let owner: SeededUser;
let member: SeededUser;
let account: SeededAccount;
let sessionA: string;
let sessionB: string;

beforeAll(async () => {
  t = await createTestDatabase('account-metrics');
  owner = await seedUser(t.db);
  member = await seedUser(t.db);
  account = await seedAccount(t.db, { owner: owner.id, name: 'Metric Mira' });

  // Two sessions on Monday 5 October: A 18:00–19:00 (bossing), B 20:00–20:30 (fishing).
  const [a, b] = await t.db
    .insert(playSessions)
    .values([
      {
        accountId: account.id,
        startedAt: at('2026-10-05T18:00:00Z'),
        lastSeenAt: at('2026-10-05T19:00:00Z'),
        endedAt: at('2026-10-05T19:00:00Z'),
        endReason: 'logout',
      },
      {
        accountId: account.id,
        startedAt: at('2026-10-05T20:00:00Z'),
        lastSeenAt: at('2026-10-05T20:30:00Z'),
        endedAt: at('2026-10-05T20:30:00Z'),
        endReason: 'logout',
      },
    ])
    .returning({ id: playSessions.id });
  sessionA = a!.id;
  sessionB = b!.id;

  // XP: a value before the range, then Ranged in session A's first half, Fishing in session B.
  await seedXp(t.db, account.id, [
    ['Ranged', '2026-08-01T00:00:00Z', 1_000_000],
    ['Fishing', '2026-08-01T00:00:00Z', 500_000],
    ['Ranged', '2026-10-05T18:00:00Z', 1_010_000],
    ['Ranged', '2026-10-05T18:05:00Z', 1_020_000],
    ['Ranged', '2026-10-05T18:10:00Z', 1_030_000],
    ['Fishing', '2026-10-05T20:00:00Z', 505_000],
    ['Fishing', '2026-10-05T20:10:00Z', 510_000],
    // Mobile play the hiscores filled in on Wednesday: XP, but never an active bucket.
    ['Fishing', '2026-10-07T09:00:00Z', 530_000],
    // Overall is its own row, as ingest stores it.
    ['Overall', '2026-08-01T00:00:00Z', 1_500_000],
    ['Overall', '2026-10-05T18:00:00Z', 1_510_000],
    ['Overall', '2026-10-05T18:05:00Z', 1_520_000],
    ['Overall', '2026-10-05T18:10:00Z', 1_530_000],
    ['Overall', '2026-10-05T20:00:00Z', 1_535_000],
    ['Overall', '2026-10-05T20:10:00Z', 1_540_000],
    ['Overall', '2026-10-07T09:00:00Z', 1_560_000],
  ]);
  await t.db.insert(hiscoreXpFills).values({
    accountId: account.id,
    skillId: await skillId(t.db, 'Fishing'),
    bucket: at('2026-10-07T09:00:00Z'),
    xp: 530_000,
  });
  await seedLatestState(t.db, account.id, {
    lastSeen: at('2026-10-07T09:00:00Z'),
    skills: skillMap({ Ranged: [1_030_000, 73], Fishing: [530_000, 67] }),
    skillsUpdatedAt: at('2026-10-07T09:00:00Z'),
  });

  // Loot: two Zulrah drops in session A (one with a collection log entry), one late in the range.
  const loot = (iso: string, value: number, source: string) =>
    seedEvent(t.db, account.id, {
      type: 'loot',
      occurredAt: at(iso),
      valueGp: value,
      data: { type: 'loot', data: { source: { text: source } }, eventId: iso, timestamp: 0 },
    });
  await loot('2026-10-05T18:31:00Z', 100_000, 'Zulrah');
  await loot('2026-10-05T18:41:00Z', 2_000_000, 'Zulrah');
  await seedEvent(t.db, account.id, {
    type: 'collection_log',
    occurredAt: at('2026-10-05T18:41:03Z'),
    valueGp: 2_000_000,
    data: {
      type: 'collectionLog',
      data: { itemName: 'Tanzanite fang', killCount: 140 },
      eventId: 'clog',
      timestamp: 0,
    },
  });
  await seedEvent(t.db, account.id, {
    type: 'level_up',
    occurredAt: at('2026-10-05T18:12:00Z'),
    skill: 'Ranged',
    level: 74,
    data: { type: 'levelUp', data: [{ skill: 'Ranged', level: 74 }], eventId: 'lvl', timestamp: 0 },
  });

  // Hiscores: first reading a baseline (lifetime 130), then +20 after session A, +3 on mobile.
  await t.db.insert(activityScores).values([
    {
      accountId: account.id,
      activity: 'Zulrah',
      readAt: at('2026-10-01T10:00:00Z'),
      score: 130,
      baseline: true,
    },
    {
      accountId: account.id,
      activity: 'Zulrah',
      readAt: at('2026-10-05T19:10:00Z'),
      score: 150,
      baseline: false,
    },
    {
      accountId: account.id,
      activity: 'Zulrah',
      readAt: at('2026-10-08T10:00:00Z'),
      score: 153,
      baseline: false,
    },
    // A clue count isn't a boss: not in kills.
    {
      accountId: account.id,
      activity: 'Clue Scrolls (all)',
      readAt: at('2026-10-01T10:00:00Z'),
      score: 10,
      baseline: true,
    },
    {
      accountId: account.id,
      activity: 'Clue Scrolls (all)',
      readAt: at('2026-10-05T19:10:00Z'),
      score: 12,
      baseline: false,
    },
  ]);
  await t.db.insert(accountHiscores).values({
    accountId: account.id,
    lookupName: 'Metric Mira',
    mode: 'regular',
    status: 'ok',
    lastAttemptAt: at('2026-10-08T10:00:00Z'),
    fetchedAt: at('2026-10-08T10:00:00Z'),
    main: {
      skills: [{ name: 'Overall', rank: 10, level: 140, xp: 1_560_000 }],
      activities: [
        { name: 'Clue Scrolls (all)', rank: 9000, score: 12 },
        { name: 'Zulrah', rank: 500, score: 153 },
      ],
    },
  });
  await t.db.insert(wealthDaily).values([
    { accountId: account.id, day: '2026-09-01', lastValue: 1_000, maxValue: 1_000 },
    { accountId: account.id, day: '2026-10-08', lastValue: 5_000, maxValue: 6_000 },
  ]);
});

afterAll(() => t.drop());

describe('getAccountMetrics', () => {
  it('is null for an account the viewer may not see', async () => {
    const stranger = await seedAccount(t.db, { owner: owner.id });
    for (const c of [
      'stats',
      'events',
      'activity',
      'location_live',
      'location_history',
      'equipment',
      'inventory',
      'hiscores',
    ] as const) {
      await seedSharing(t.db, stranger.id, c, 'private');
    }
    expect(
      await getAccountMetrics(t.db, member.viewer, stranger.publicId, query(), OPTS),
    ).toBeNull();
    expect(await getAccountMetrics(t.db, member.viewer, 'nope', query(), OPTS)).toBeNull();
  });

  it('totals the range: all XP (hiscores fills included), loot, boss kills without the baseline, wealth', async () => {
    const m = (await getAccountMetrics(
      t.db,
      owner.viewer,
      account.publicId,
      query({ range: '7d' }),
      OPTS,
    ))!;
    expect(m.access).toMatchObject({ stats: true, events: true, hiscores: true, sessions: true });
    expect(m.totals).toMatchObject({
      xp: 30_000 + 30_000,
      gp: 2_100_000,
      drops: 2,
      kills: 23,
      wealthChange: 4_000,
      sessionXp: 40_000,
      sessionGp: 2_100_000,
    });
    expect(m.totals.sessions).toEqual({
      sessions: 2,
      onlineMs: 90 * MIN,
      activeMs: 35 * MIN,
      value: 40_000,
    });
  });

  it('builds each session with effective time, its kills and main activity, newest first', async () => {
    const m = (await getAccountMetrics(
      t.db,
      owner.viewer,
      account.publicId,
      query({ range: '7d' }),
      OPTS,
    ))!;
    expect(m.sessions!.map((s) => s.id)).toEqual([sessionB, sessionA]);
    const a = m.sessions!.find((s) => s.id === sessionA)!;
    // Ranged in 3 buckets, the drops in 2 more.
    expect(a).toMatchObject({
      onlineMs: HOUR,
      activeMs: 25 * MIN,
      xp: 30_000,
      gp: 2_100_000,
      kills: [{ activity: 'Zulrah', kills: 20 }],
      killsShared: false,
      main: { kind: 'boss', name: 'Zulrah' },
    });
    expect(m.records).toMatchObject({ mostXp: sessionA, longest: sessionA, mostKills: sessionA });
    const mon18 = m.heatmap!.find((c) => c.weekday === 0 && c.hour === 18)!;
    expect(mon18).toMatchObject({ onlineMs: HOUR, activeMs: 25 * MIN, value: 30_000, sessions: 1 });
    expect(m.options.activities).toEqual(['Fishing', 'Zulrah']);
    expect(m.bosses).toEqual([
      { activity: 'Zulrah', score: 153, rank: 500, modeRank: null, gained: 23, gp: 2_100_000 },
    ]);
  });

  it('narrows the session charts with the filters but not the period totals', async () => {
    const m = (await getAccountMetrics(
      t.db,
      owner.viewer,
      account.publicId,
      query({ range: '7d', activity: 'Fishing' }),
      OPTS,
    ))!;
    expect(m.sessions!.map((s) => s.id)).toEqual([sessionB]);
    expect(m.matching).toMatchObject({ sessions: 1, value: 10_000 });
    expect(m.totals.xp).toBe(60_000);
  });

  it('gives the timeline of a selected session with its markers', async () => {
    const m = (await getAccountMetrics(
      t.db,
      owner.viewer,
      account.publicId,
      query({ session: sessionA }),
      OPTS,
    ))!;
    expect(m.timeline!.session.id).toBe(sessionA);
    expect(m.timeline!.buckets).toHaveLength(13);
    expect(m.timeline!.buckets[0]).toMatchObject({ active: true, xp: { Ranged: 10_000 } });
    expect(m.timeline!.markers.map((x) => x.type)).toEqual([
      'level_up',
      'loot',
      'loot',
      'collection_log',
    ]);
    expect(m.timeline!.markers[0]!.line).toBe('Metric Mira reached level 74 Ranged');
    // Another account's session id shows nothing.
    const other = (await getAccountMetrics(
      t.db,
      owner.viewer,
      account.publicId,
      query({ session: '00000000-0000-7000-8000-000000000000' }),
      OPTS,
    ))!;
    expect(other.timeline).toBeNull();
  });

  it('compares the measure with the period before', async () => {
    const m = (await getAccountMetrics(
      t.db,
      owner.viewer,
      account.publicId,
      query({ range: '7d', compare: true, measure: 'kills' }),
      OPTS,
    ))!;
    expect(m.comparison!.stepMs).toBe(24 * HOUR);
    expect(m.comparison!.current.at(-1)![1]).toBe(23);
    // The first reading (1 October, inside the week before) is a baseline: nothing.
    expect(m.comparison!.previous!.at(-1)![1]).toBe(0);
  });

  it('leaves out every panel whose category the viewer lacks', async () => {
    for (const c of ['activity', 'hiscores', 'events', 'inventory'] as const) {
      await seedSharing(t.db, account.id, c, 'private');
    }
    try {
      const m = (await getAccountMetrics(
        t.db,
        member.viewer,
        account.publicId,
        query({ range: '7d', measure: 'kills' }),
        OPTS,
      ))!;
      expect(m.access).toMatchObject({
        stats: true,
        sessions: false,
        hiscores: false,
        events: false,
      });
      expect(m.totals).toMatchObject({ gp: null, kills: null, wealthChange: null, sessions: null });
      expect(m.totals.xp).toBe(60_000);
      expect(m.sessions).toBeNull();
      expect(m.heatmap).toBeNull();
      expect(m.bosses).toBeNull();
      expect(m.comparison).toBeNull();
      expect(m.canSetGoals).toBe(false);
      const xp = (await getAccountMetrics(
        t.db,
        member.viewer,
        account.publicId,
        query({ range: '7d', session: sessionA }),
        OPTS,
      ))!;
      // Without activity: days only, and no session timeline.
      expect(xp.comparison!.stepMs).toBe(24 * HOUR);
      expect(xp.timeline).toBeNull();
    } finally {
      for (const c of ['activity', 'hiscores', 'events', 'inventory'] as const) {
        await seedSharing(t.db, account.id, c, 'guild');
      }
    }
  });

  it('gives per-skill XP per hour over the buckets the skill was trained in, and the time to level', async () => {
    const m = (await getAccountMetrics(
      t.db,
      owner.viewer,
      account.publicId,
      query({ range: '7d' }),
      OPTS,
    ))!;
    const ranged = m.skills!.find((s) => s.skill === 'Ranged')!;
    expect(ranged).toMatchObject({ xp: 1_030_000, level: 73, gained: 30_000, xpPerHour: 120_000 });
    expect(ranged.etaMs).toBeCloseTo(((1_096_278 - 1_030_000) / 120_000) * HOUR, 0);
  });
});

describe('goals', () => {
  it('lets the owner set, replace and remove goals, and shows progress with an ETA', async () => {
    await expect(
      setGoal(t.db, member.viewer, account.publicId, {
        kind: 'level',
        target: 'Ranged',
        value: 80,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      setGoal(t.db, owner.viewer, account.publicId, {
        kind: 'level',
        target: 'Overall',
        value: 80,
      }),
    ).rejects.toBeInstanceOf(GoalError);
    await expect(
      setGoal(t.db, owner.viewer, account.publicId, {
        kind: 'level',
        target: 'Ranged',
        value: 127,
      }),
    ).rejects.toMatchObject({ code: 'invalid' });

    await setGoal(t.db, owner.viewer, account.publicId, {
      kind: 'level',
      target: 'Ranged',
      value: 80,
    });
    const kc = await setGoal(t.db, owner.viewer, account.publicId, {
      kind: 'kc',
      target: 'Zulrah',
      value: 200,
    });
    await setGoal(t.db, owner.viewer, account.publicId, {
      kind: 'kc',
      target: 'Zulrah',
      value: 176,
    });

    const m = (await getAccountMetrics(
      t.db,
      member.viewer,
      account.publicId,
      query({ range: '7d' }),
      OPTS,
    ))!;
    expect(m.goals.map((g) => [g.kind, g.target, g.value])).toEqual([
      ['level', 'Ranged', 80],
      ['kc', 'Zulrah', 176],
    ]);
    const zulrah = m.goals[1]!;
    expect(zulrah).toMatchObject({ current: 153, remaining: 23 });
    // 23 kills in the 7 days: 23 more take 7 days.
    expect(zulrah.etaDays).toBeCloseTo(7, 5);
    expect(m.goals[0]).toMatchObject({ current: 73, remaining: 1_986_068 - 1_030_000 });

    // A member who may not read hiscores doesn't see the kill-count goal.
    await seedSharing(t.db, account.id, 'hiscores', 'private');
    const hidden = (await getAccountMetrics(t.db, member.viewer, account.publicId, query(), OPTS))!;
    expect(hidden.goals.map((g) => g.kind)).toEqual(['level']);
    await seedSharing(t.db, account.id, 'hiscores', 'guild');

    expect(await deleteGoal(t.db, owner.viewer, account.publicId, kc.id)).toBe(true);
    expect(await deleteGoal(t.db, owner.viewer, account.publicId, kc.id)).toBe(false);
    await expect(deleteGoal(t.db, member.viewer, account.publicId, kc.id)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});

describe('getBossMetrics', () => {
  it('gives kills, loot per kill, uniques and the kills since the last one', async () => {
    const page = (await getBossMetrics(
      t.db,
      owner.viewer,
      account.publicId,
      'Zulrah',
      { range: '7d', from: null, to: null },
      OPTS,
    ))!;
    expect(page).toMatchObject({
      hiscore: { score: 153, rank: 500 },
      kills: 23,
      gp: 2_100_000,
      drops: 2,
      step: 'day',
      killsSinceUnique: 13,
    });
    expect(page.gpPerKill).toBeCloseTo(2_100_000 / 23, 5);
    expect(page.uniques).toEqual([
      { at: '2026-10-05T18:41:03.000Z', item: 'Tanzanite fang', value: 2_000_000, killCount: 140 },
    ]);
    expect(page.periods).toHaveLength(8);
    expect(page.periods.find((p) => p.start === '2026-10-05')).toEqual({
      start: '2026-10-05',
      kills: 20,
      gp: 2_100_000,
    });
    expect(page.sessions).toEqual([
      expect.objectContaining({
        id: sessionA,
        kills: 20,
        shared: false,
        msPerKill: HOUR / 20,
        gp: 2_100_000,
      }),
    ]);
  });

  it('is null without hiscores', async () => {
    await seedSharing(t.db, account.id, 'hiscores', 'private');
    expect(
      await getBossMetrics(
        t.db,
        member.viewer,
        account.publicId,
        'Zulrah',
        { range: '7d', from: null, to: null },
        OPTS,
      ),
    ).toBeNull();
    await seedSharing(t.db, account.id, 'hiscores', 'guild');
  });
});

describe('getBossLeaderboards', () => {
  it('ranks kills gained per boss, never a baseline, never an account hidden from the guild', async () => {
    const rival = await seedAccount(t.db, { owner: member.id, name: 'Rival' });
    const hidden = await seedAccount(t.db, {
      owner: member.id,
      name: 'Hidden',
      hiddenFromGuild: true,
    });
    const fresh = await seedAccount(t.db, { owner: member.id, name: 'Fresh' });
    await t.db.insert(activityScores).values([
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
        accountId: hidden.id,
        activity: 'Zulrah',
        readAt: at('2026-09-20T10:00:00Z'),
        score: 1,
        baseline: true,
      },
      {
        accountId: hidden.id,
        activity: 'Zulrah',
        readAt: at('2026-10-08T10:00:00Z'),
        score: 999,
        baseline: false,
      },
      // Only a first reading: lifetime kills, not a gain.
      {
        accountId: fresh.id,
        activity: 'Zulrah',
        readAt: at('2026-10-08T10:00:00Z'),
        score: 5000,
        baseline: true,
      },
      {
        accountId: rival.id,
        activity: 'Vorkath',
        readAt: at('2026-09-10T10:00:00Z'),
        score: 50,
        baseline: true,
      },
      {
        accountId: rival.id,
        activity: 'Vorkath',
        readAt: at('2026-09-15T10:00:00Z'),
        score: 55,
        baseline: false,
      },
    ]);
    const boards = await getBossLeaderboards(t.db, member.viewer, OPTS);
    expect(boards.week).toEqual([
      {
        activity: 'Zulrah',
        entries: [
          { publicId: rival.publicId, name: 'Rival', kills: 30 },
          { publicId: account.publicId, name: 'Metric Mira', kills: 23 },
        ],
      },
    ]);
    expect(boards.month.map((b) => b.activity)).toEqual(['Zulrah', 'Vorkath']);
  });
});

describe('resolveMetricsRange', () => {
  it('starts today at local midnight and the presets as rolling windows', () => {
    expect(
      resolveMetricsRange({ range: 'today', from: null, to: null }, NOW, 'Asia/Tokyo').from,
    ).toEqual(at('2026-10-08T15:00:00Z'));
    expect(resolveMetricsRange({ range: '7d', from: null, to: null }, NOW, 'UTC').from).toEqual(
      at('2026-10-02T12:00:00Z'),
    );
  });

  it('takes custom days as whole local days, cut at now and at a year', () => {
    expect(
      resolveMetricsRange(
        { range: 'custom', from: '2026-10-01', to: '2026-10-02' },
        NOW,
        'Europe/Amsterdam',
      ),
    ).toEqual({
      from: at('2026-09-30T22:00:00Z'),
      to: at('2026-10-02T22:00:00Z'),
      preset: 'custom',
    });
    expect(
      resolveMetricsRange({ range: 'custom', from: '2020-01-01', to: '2030-01-01' }, NOW, 'UTC'),
    ).toEqual({ from: at('2025-10-08T12:00:00Z'), to: NOW, preset: 'custom' });
    expect(
      resolveMetricsRange({ range: 'custom', from: '2026-10-05', to: '2026-10-01' }, NOW, 'UTC')
        .preset,
    ).toBe('30d');
  });

  it('finds local midnight across DST and far from UTC', () => {
    expect(startOfLocalDate('2026-10-25', 'Europe/Amsterdam')).toEqual(at('2026-10-24T22:00:00Z'));
    expect(startOfLocalDate('2026-10-09', 'Pacific/Kiritimati')).toEqual(
      at('2026-10-08T10:00:00Z'),
    );
    expect(startOfLocalDate('bad', 'UTC')).toBeNull();
  });
});
