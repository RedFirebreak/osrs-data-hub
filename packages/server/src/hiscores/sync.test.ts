import { XP_BUCKET_MS, floorTo } from '@hub/core';
import {
  accountHiscores,
  activityScores,
  hiscoreXpFills,
  latestState,
  playSessions,
  xpSamples,
} from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedAccount, seedLatestState, seedXp, skillId, skillMap } from '../accounts/test-support';
import { createTestMetrics } from '../metrics';
import { countsBy, valueOf } from '../metrics-test-support';
import type { FetchFn } from './client';
import { HiscorePause } from './pause';
import { loadHiscoresViews } from './read';
import { syncHiscores, type SyncHiscoresDeps } from './sync';

const BASE = 'http://hiscores.test';
const NOW = new Date('2026-10-09T12:00:00Z');
const MIN = 60_000;

let t: TestDatabase;

beforeEach(async () => {
  t = await createTestDatabase('hiscoresync');
});

afterEach(async () => {
  await t.drop();
});

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

/** A fake hiscores: `players[table][name]` is a reply; anything else is a 404. */
function fakeHiscores(players: Record<string, Record<string, Reply>>) {
  const requests: string[] = [];
  const fetchFn: FetchFn = async (input) => {
    const url = new URL(String(input));
    requests.push(`${url.pathname.split('/')[1]}?${url.searchParams.get('player')}`);
    const table = url.pathname.split('/')[1]!.replace(/^m=/, '');
    const reply = players[table]?.[url.searchParams.get('player') ?? ''] ?? { status: 404 };
    return new Response(
      reply.body === undefined
        ? 'not found'
        : typeof reply.body === 'string'
          ? reply.body
          : JSON.stringify(reply.body),
      { status: reply.status, headers: reply.headers },
    );
  };
  return { fetchFn, requests };
}

/** An index_lite.json body: skills as [name, rank, level, xp], activities as [name, rank, score]. */
function body(
  skills: [string, number, number, number][],
  activities: [string, number, number][] = [],
) {
  return {
    name: 'x',
    skills: skills.map(([name, rank, level, xp], id) => ({ id, name, rank, level, xp })),
    activities: activities.map(([name, rank, score], id) => ({ id, name, rank, score })),
  };
}

const ok = (b: ReturnType<typeof body>): Reply => ({ status: 200, body: b });

function deps(fetchFn: FetchFn, extra: Partial<SyncHiscoresDeps> = {}) {
  const sleeps: number[] = [];
  const metrics = createTestMetrics();
  const pause = new HiscorePause();
  return {
    sleeps,
    metrics,
    pause,
    deps: {
      baseUrl: BASE,
      requestIntervalMs: 3000,
      fetchFn,
      now: () => NOW,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      pause,
      metrics,
      ...extra,
    } satisfies SyncHiscoresDeps,
  };
}

const row = async (accountId: number) =>
  (await t.db.select().from(accountHiscores).where(eq(accountHiscores.accountId, accountId)))[0];

const scores = async (accountId: number) =>
  (
    await t.db
      .select({
        activity: activityScores.activity,
        score: activityScores.score,
        baseline: activityScores.baseline,
      })
      .from(activityScores)
      .where(eq(activityScores.accountId, accountId))
      .orderBy(asc(activityScores.readAt), asc(activityScores.activity))
  ).map((r) => [r.activity, r.score, r.baseline]);

describe('syncHiscores', () => {
  it('looks up a new account and stores its tables and its scores as a baseline', async () => {
    const a = await seedAccount(t.db, { name: 'Alpha Main', accountType: 0 });
    const { fetchFn, requests } = fakeHiscores({
      hiscore_oldschool: {
        'Alpha Main': ok(
          body(
            [
              ['Overall', 100, 500, 50_000],
              ['Attack', 5, 40, 40_000],
            ],
            [
              ['Grid Points', -1, -1],
              ['Zulrah', 1200, 55],
              ['Clue Scrolls (all)', -1, 3],
            ],
          ),
        ),
      },
    });
    const { deps: d, metrics } = deps(fetchFn);

    const res = await syncHiscores(t.db, d);

    expect(res).toMatchObject({ due: 1, results: { ok: 1 }, filled: 0, pausedUntil: null });
    expect(requests).toEqual(['m=hiscore_oldschool?Alpha Main']);
    expect(await row(a.id)).toMatchObject({
      lookupName: 'Alpha Main',
      mode: 'regular',
      status: 'ok',
      lastAttemptAt: NOW,
      nextAttemptAt: null,
      fetchedAt: NOW,
      modeTable: null,
    });
    expect(await scores(a.id)).toEqual([
      ['Clue Scrolls (all)', 3, true],
      ['Zulrah', 55, true],
    ]);
    expect(await countsBy(metrics.hiscoreLookups, 'result')).toEqual({ ok: 1 });

    const view = (await loadHiscoresViews(t.db, [{ id: a.id, accountType: 0 }])).get(a.id)!;
    expect(view).toEqual({
      status: 'ok',
      fetchedAt: NOW.toISOString(),
      mode: 'regular',
      skills: [
        { skill: 'Overall', level: 500, xp: 50_000, rank: 100, modeRank: null },
        { skill: 'Attack', level: 40, xp: 40_000, rank: 5, modeRank: null },
      ],
      activities: [
        { activity: 'Zulrah', kind: 'boss', score: 55, rank: 1200, modeRank: null },
        { activity: 'Clue Scrolls (all)', kind: 'clue', score: 3, rank: null, modeRank: null },
      ],
    });
  });

  it("reads an iron account's own table too, and shows its ranks beside the main ones", async () => {
    const a = await seedAccount(t.db, { name: 'Iron Bravo', accountType: 3 });
    const { fetchFn, requests } = fakeHiscores({
      hiscore_oldschool: {
        'Iron Bravo': ok(body([['Overall', 9000, 1500, 1_000_000]], [['Vorkath', 4000, 120]])),
      },
      hiscore_oldschool_hardcore_ironman: {
        'Iron Bravo': ok(body([['Overall', 300, 1500, 1_000_000]], [['Vorkath', 20, 120]])),
      },
    });
    const { deps: d, sleeps } = deps(fetchFn);

    await syncHiscores(t.db, d);

    expect(requests).toEqual([
      'm=hiscore_oldschool?Iron Bravo',
      'm=hiscore_oldschool_hardcore_ironman?Iron Bravo',
    ]);
    expect(sleeps).toEqual([3000]);
    const view = (await loadHiscoresViews(t.db, [{ id: a.id, accountType: 3 }])).get(a.id)!;
    expect(view.mode).toBe('hardcore_ironman');
    expect(view.skills).toEqual([
      { skill: 'Overall', level: 1500, xp: 1_000_000, rank: 9000, modeRank: 300 },
    ]);
    expect(view.activities).toEqual([
      { activity: 'Vorkath', kind: 'boss', score: 120, rank: 4000, modeRank: 20 },
    ]);
  });

  it('fills XP made outside RuneLite into xp_samples and latest_state, for an offline account', async () => {
    const a = await seedAccount(t.db, { name: 'Charlie' });
    await seedLatestState(t.db, a.id, {
      lastSeen: new Date(NOW.getTime() - 3 * 60 * MIN),
      gameState: 'LOGIN_SCREEN',
      skills: skillMap({ Attack: [1000, 9], Cooking: [2000, 13] }),
    });
    await seedXp(t.db, a.id, [['Cooking', '2026-10-09T09:00:00Z', 2000]]);
    const { fetchFn } = fakeHiscores({
      hiscore_oldschool: {
        Charlie: ok(
          body([
            ['Overall', 10, 50, 13_035_431],
            ['Attack', 10, 9, 1000],
            ['Cooking', 10, 99, 13_034_431],
          ]),
        ),
      },
    });
    const { deps: d, metrics } = deps(fetchFn);

    const res = await syncHiscores(t.db, d);

    expect(res).toMatchObject({ results: { ok: 1 }, filled: 1 });
    expect(await valueOf(metrics.hiscoreXpFills)).toBe(1);
    const bucket = floorTo(NOW, XP_BUCKET_MS);
    const samples = await t.db
      .select({ skillId: xpSamples.skillId, xp: xpSamples.xp, level: xpSamples.level })
      .from(xpSamples)
      .where(eq(xpSamples.bucket, bucket));
    expect(new Map(samples.map((s) => [s.skillId, [s.xp, s.level]]))).toEqual(
      new Map([
        [await skillId(t.db, 'Cooking'), [13_034_431, 99]],
        [await skillId(t.db, 'Overall'), [13_035_431, 108]],
      ]),
    );
    // Noted as the hiscores' doing, so a chart can say where the gain came from.
    const fills = await t.db
      .select({ skillId: hiscoreXpFills.skillId, xp: hiscoreXpFills.xp })
      .from(hiscoreXpFills)
      .where(and(eq(hiscoreXpFills.accountId, a.id), eq(hiscoreXpFills.bucket, bucket)));
    expect(new Map(fills.map((f) => [f.skillId, f.xp]))).toEqual(
      new Map([
        [await skillId(t.db, 'Cooking'), 13_034_431],
        [await skillId(t.db, 'Overall'), 13_035_431],
      ]),
    );
    const [state] = await t.db
      .select({ skills: latestState.skills, at: latestState.skillsUpdatedAt })
      .from(latestState)
      .where(eq(latestState.accountId, a.id));
    expect(state).toEqual({
      skills: skillMap({ Attack: [1000, 9], Cooking: [13_034_431, 99] }),
      at: NOW,
    });
  });

  it('stores nothing but a mismatch when the hiscores have a skill lower than the plugin reported', async () => {
    const a = await seedAccount(t.db, { name: 'Delta' });
    await seedLatestState(t.db, a.id, {
      lastSeen: new Date(NOW.getTime() - 3 * 60 * MIN),
      skills: skillMap({ Attack: [5000, 20] }),
    });
    const { fetchFn } = fakeHiscores({
      hiscore_oldschool: {
        Delta: ok(
          body(
            [
              ['Overall', 1, 10, 100],
              ['Attack', 1, 2, 100],
            ],
            [['Zulrah', 1, 50]],
          ),
        ),
      },
    });
    const { deps: d } = deps(fetchFn);

    const res = await syncHiscores(t.db, d);

    expect(res).toMatchObject({ results: { mismatch: 1 }, filled: 0 });
    expect(await row(a.id)).toMatchObject({
      status: 'mismatch',
      fetchedAt: null,
      main: null,
      nextAttemptAt: new Date(NOW.getTime() + 60 * MIN),
    });
    expect(await scores(a.id)).toEqual([]);
    expect(await t.db.select().from(xpSamples)).toEqual([]);
  });

  it('looks up a new account that is online, without checking or filling its XP', async () => {
    const a = await seedAccount(t.db, { name: 'Echo' });
    await seedLatestState(t.db, a.id, {
      lastSeen: new Date(NOW.getTime() - 10_000),
      gameState: 'LOGGED_IN',
      tickDelay: 0,
      skills: skillMap({ Attack: [5000, 20] }),
    });
    const { fetchFn } = fakeHiscores({
      hiscore_oldschool: {
        Echo: ok(
          body([
            ['Overall', 1, 10, 100],
            ['Attack', 1, 2, 100],
          ]),
        ),
      },
    });
    const { deps: d } = deps(fetchFn);

    expect(await syncHiscores(t.db, d)).toMatchObject({ results: { ok: 1 }, filled: 0 });
    expect((await row(a.id))?.status).toBe('ok');

    // Looked up now, and online: not due again, whatever happens to it.
    await t.db
      .update(accountHiscores)
      .set({ lastAttemptAt: new Date(NOW.getTime() - 30 * 60 * MIN) });
    expect((await syncHiscores(t.db, d)).due).toBe(0);
  });

  it('keeps the last good tables after not_found, and waits six hours unless the name changes', async () => {
    const a = await seedAccount(t.db, { name: 'Foxtrot' });
    const { fetchFn, requests } = fakeHiscores({
      hiscore_oldschool: { Foxtrot: ok(body([['Overall', 1, 10, 100]], [['Zulrah', 1, 9]])) },
    });
    let clock = NOW;
    const { deps: d } = deps(fetchFn, { now: () => clock });
    await syncHiscores(t.db, d);

    // A day later the name is gone from the hiscores.
    clock = new Date(NOW.getTime() + 24 * 60 * MIN);
    const gone = fakeHiscores({});
    expect(await syncHiscores(t.db, { ...d, fetchFn: gone.fetchFn })).toMatchObject({
      results: { not_found: 1 },
    });
    expect(await row(a.id)).toMatchObject({
      status: 'not_found',
      fetchedAt: NOW,
      lastAttemptAt: clock,
      nextAttemptAt: new Date(clock.getTime() + 6 * 60 * MIN),
    });
    const view = (await loadHiscoresViews(t.db, [{ id: a.id, accountType: null }])).get(a.id)!;
    expect(view).toMatchObject({ status: 'not_found', fetchedAt: NOW.toISOString() });
    expect(view.activities).toHaveLength(1);

    clock = new Date(clock.getTime() + 2 * 60 * MIN);
    expect((await syncHiscores(t.db, { ...d, fetchFn: gone.fetchFn })).due).toBe(0);

    // The plugin reports the new name: looked up at once.
    const { osrsAccounts } = await import('@hub/db');
    await t.db.update(osrsAccounts).set({ currentName: 'Foxtrot Two' });
    expect(await syncHiscores(t.db, { ...d, fetchFn: gone.fetchFn })).toMatchObject({ due: 1 });
    expect(requests).toEqual(['m=hiscore_oldschool?Foxtrot']);
  });

  it('pauses every lookup when the hiscores push back, and stores nothing', async () => {
    const a = await seedAccount(t.db, { name: 'Golf' });
    await seedAccount(t.db, { name: 'Hotel' });
    const { fetchFn, requests } = fakeHiscores({
      hiscore_oldschool: { Golf: { status: 429, headers: { 'retry-after': '300' } } },
    });
    const { deps: d, metrics, pause } = deps(fetchFn);

    const res = await syncHiscores(t.db, d);

    expect(res).toMatchObject({
      due: 2,
      results: { throttled: 1, ok: 0 },
      pausedUntil: new Date(NOW.getTime() + 300_000).toISOString(),
    });
    expect(requests).toEqual(['m=hiscore_oldschool?Golf']);
    expect(await row(a.id)).toBeUndefined();
    expect(await countsBy(metrics.hiscoreLookups, 'result')).toEqual({ throttled: 1 });
    expect(pause.pausedUntil(NOW)).toEqual(new Date(NOW.getTime() + 300_000));

    // While paused, a run makes no request at all.
    expect(await syncHiscores(t.db, d)).toMatchObject({ due: 0 });
    expect(requests).toHaveLength(1);
  });

  it('treats a page that is not the hiscores as a push-back', async () => {
    await seedAccount(t.db, { name: 'India' });
    const { fetchFn } = fakeHiscores({
      hiscore_oldschool: { India: { status: 200, body: '<html>Just a moment...</html>' } },
    });
    const { deps: d } = deps(fetchFn);
    expect(await syncHiscores(t.db, d)).toMatchObject({
      results: { throttled: 1 },
      pausedUntil: new Date(NOW.getTime() + 60_000).toISOString(),
    });
  });

  it('looks up again 10 minutes after a session ends, and logs only the scores that changed', async () => {
    const a = await seedAccount(t.db, { name: 'Juliet' });
    let zulrah = 50;
    let vardorvis = -1;
    const fetchFn: FetchFn = async () =>
      new Response(
        JSON.stringify(
          body(
            [['Overall', 1, 10, 100]],
            [
              ['Zulrah', 1, zulrah],
              ['Vorkath', 1, 7],
              ['Vardorvis', -1, vardorvis],
            ],
          ),
        ),
      );
    let clock = NOW;
    const { deps: d } = deps(fetchFn, { now: () => clock });
    await syncHiscores(t.db, d);

    await t.db.insert(playSessions).values({
      accountId: a.id,
      startedAt: new Date(NOW.getTime() + 5 * MIN),
      lastSeenAt: new Date(NOW.getTime() + 60 * MIN),
      endedAt: new Date(NOW.getTime() + 60 * MIN),
      endReason: 'logout',
    });
    zulrah = 60;
    vardorvis = 5;
    clock = new Date(NOW.getTime() + 69 * MIN);
    expect((await syncHiscores(t.db, d)).due).toBe(0);
    clock = new Date(NOW.getTime() + 70 * MIN);
    expect(await syncHiscores(t.db, d)).toMatchObject({ due: 1, results: { ok: 1 } });
    // A gain on Zulrah; Vardorvis appears at 5 kills, which is where its series starts, not a gain.
    expect(await scores(a.id)).toEqual([
      ['Vorkath', 7, true],
      ['Zulrah', 50, true],
      ['Vardorvis', 5, true],
      ['Zulrah', 60, false],
    ]);
  });

  it('starts every series over as a baseline after a rename, and after the name was gone', async () => {
    const a = await seedAccount(t.db, { name: 'Mike' });
    const reply = ok(body([['Overall', 1, 10, 100]], [['Zulrah', 1, 9]]));
    let clock = NOW;
    const first = fakeHiscores({ hiscore_oldschool: { Mike: reply } });
    const { deps: d } = deps(first.fetchFn, { now: () => clock });
    await syncHiscores(t.db, d);

    // Renamed: the new name's 9 kills may belong to someone else's history, so it is a new baseline.
    const { osrsAccounts } = await import('@hub/db');
    await t.db.update(osrsAccounts).set({ currentName: 'Mike Two' });
    clock = new Date(NOW.getTime() + MIN);
    const renamed = fakeHiscores({ hiscore_oldschool: { 'Mike Two': reply } });
    await syncHiscores(t.db, { ...d, fetchFn: renamed.fetchFn });
    expect(await scores(a.id)).toEqual([
      ['Zulrah', 9, true],
      ['Zulrah', 9, true],
    ]);

    // Gone from the hiscores for a while, then back: what happened in between is not a gain.
    clock = new Date(clock.getTime() + 24 * 60 * MIN);
    await syncHiscores(t.db, { ...d, fetchFn: fakeHiscores({}).fetchFn });
    clock = new Date(clock.getTime() + 24 * 60 * MIN);
    const back = fakeHiscores({
      hiscore_oldschool: { 'Mike Two': ok(body([['Overall', 1, 10, 100]], [['Zulrah', 1, 20]])) },
    });
    await syncHiscores(t.db, { ...d, fetchFn: back.fetchFn });
    expect((await scores(a.id)).at(-1)).toEqual(['Zulrah', 20, true]);
  });

  it('stops starting lookups once its time budget is spent', async () => {
    await seedAccount(t.db, { name: 'Kilo' });
    await seedAccount(t.db, { name: 'Lima' });
    const { fetchFn, requests } = fakeHiscores({});
    let clock = NOW;
    const { deps: d } = deps(fetchFn, {
      now: () => clock,
      budgetMs: 1000,
      sleep: async (ms) => {
        clock = new Date(clock.getTime() + ms);
      },
    });
    const res = await syncHiscores(t.db, d);
    expect(res).toMatchObject({ due: 2, results: { not_found: 1 } });
    expect(requests).toHaveLength(1);
  });
});
