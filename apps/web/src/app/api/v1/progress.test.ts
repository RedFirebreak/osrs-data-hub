/**
 * GET /api/v1/accounts/{id}/progress and GET /api/v1/leaderboards/kills (D-139) over ingested
 * fixtures: the documented shape, a section per category the key reads (the account 404s when it
 * reads none, D-70), and 400 for a range or period they can't answer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { KillsLeaderboardResponse, ProgressResponse } from '@/lib/api-v1/schemas';
import { setApiLimitsForTests } from '@/lib/api-v1/with-api-key';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { GET } from './accounts/[id]/progress/route';
import { GET as getKills } from './leaderboards/kills/route';
import {
  ACCOUNT_404,
  ATTACK_GAIN,
  RANDOM_ID,
  expectShape,
  freshLimits,
  idParams,
  makeKey,
  seedWorld,
  v1Request,
  type TestKey,
  type World,
} from './test-support';

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  connection: () => Promise.resolve(),
}));

let ctx: WebTestContext;
let world: World;
let memberKey: TestKey;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'v1progress' });
  world = await seedWorld(ctx);
  memberKey = await makeKey(ctx, world.memberId);
});
beforeEach(() => {
  freshLimits();
});
afterAll(async () => {
  setApiLimitsForTests();
  await ctx.cleanup();
});

function call(key: TestKey, id: string, query = '') {
  return GET(v1Request(ctx, `/accounts/${id}/progress${query}`, { key: key.key }), idParams(id));
}

describe('GET /accounts/{id}/progress', () => {
  it('answers the last 7 days with every section the key reads', async () => {
    const res = await call(memberKey, world.main.id);
    expect(res.status).toBe(200);
    const { data } = expectShape(ProgressResponse, await res.json());
    expect(data).toMatchObject({
      account: { id: world.main.id, name: world.main.name },
      timezone: 'UTC',
      range: '7d',
    });
    expect(data.playtime?.sessions).toBeGreaterThanOrEqual(1);
    expect(data.xp?.gained).toBe(ATTACK_GAIN);
    expect(data.xp?.skills[0]).toMatchObject({ skill: 'Attack', gained: ATTACK_GAIN });
    expect(data.loot?.drops).toBe(1);
    expect(data.bosses).toMatchObject({ kills: 0, read_at: null });
    expect(data).toHaveProperty('wealth');
    expect(data.goals).toEqual([]);
  });

  it('leaves out what the key cannot read, and 404s when it reads none of it', async () => {
    const statsKey = await makeKey(ctx, world.memberId, { categories: ['stats'] });
    const { data } = expectShape(
      ProgressResponse,
      await (await call(statsKey, world.main.id, '?range=30d')).json(),
    );
    expect(data.range).toBe('30d');
    expect(data.xp).toBeDefined();
    for (const section of ['playtime', 'loot', 'bosses', 'wealth']) {
      expect(data).not.toHaveProperty(section);
    }
    const liveKey = await makeKey(ctx, world.memberId, { categories: ['location_live'] });
    for (const res of [await call(liveKey, world.main.id), await call(memberKey, RANDOM_ID)]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(ACCOUNT_404);
    }
  });

  it('takes a custom range, and 400s for one it cannot answer', async () => {
    const ok = await call(memberKey, world.main.id, '?from=2026-10-01&to=2026-10-07');
    expect(expectShape(ProgressResponse, await ok.json()).data.range).toBe('custom');
    for (const query of [
      '?range=2w',
      '?from=2026-10-01',
      '?range=7d&from=2026-10-01&to=2026-10-02',
      '?from=2026-10-05&to=2026-10-01',
      '?from=yesterday&to=2026-10-01',
    ]) {
      expect((await call(memberKey, world.main.id, query)).status, query).toBe(400);
    }
  });
});

describe('GET /leaderboards/kills', () => {
  const kills = (key: TestKey, query = '') =>
    getKills(v1Request(ctx, `/leaderboards/kills${query}`, { key: key.key }));

  it('answers the documented shape, a week by default', async () => {
    const res = await kills(memberKey);
    expect(res.status).toBe(200);
    const { data } = expectShape(KillsLeaderboardResponse, await res.json());
    expect(data).toMatchObject({ period: 'week', leaderboards: [] });
    const one = expectShape(
      KillsLeaderboardResponse,
      await (await kills(memberKey, '?boss=Zulrah&period=month')).json(),
    );
    expect(one.data).toMatchObject({
      period: 'month',
      leaderboards: [{ boss: 'Zulrah', entries: [] }],
    });
  });

  it('400 for a period it has no board for', async () => {
    expect((await kills(memberKey, '?period=day')).status).toBe(400);
  });
});
