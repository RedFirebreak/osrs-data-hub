/**
 * GET /api/v1/accounts/{id}/day (M8, D-138) over ingested fixtures: the documented shape, a section
 * per category the key reads (the account 404s when it reads none, D-70), and 400 for dates it
 * can't answer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DayResponse } from '@/lib/api-v1/schemas';
import { setApiLimitsForTests } from '@/lib/api-v1/with-api-key';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { GET } from './accounts/[id]/day/route';
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
  ctx = await withTestDb({ label: 'v1day' });
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
  return GET(v1Request(ctx, `/accounts/${id}/day${query}`, { key: key.key }), idParams(id));
}

describe('GET /accounts/{id}/day', () => {
  it('answers today with every section the key reads', async () => {
    const res = await call(memberKey, world.main.id);
    expect(res.status).toBe(200);
    const { data } = expectShape(DayResponse, await res.json());
    const today = new Date().toISOString().slice(0, 10);
    expect(data).toMatchObject({
      account: { id: world.main.id, name: world.main.name },
      timezone: 'UTC',
      dates: { from: today, to: today },
      from: `${today}T00:00:00.000Z`,
    });
    expect(data.sessions?.count).toBeGreaterThanOrEqual(1);
    expect(data.gains).toEqual({
      total: ATTACK_GAIN,
      skills: [{ skill: 'Attack', xp: ATTACK_GAIN }],
    });
    expect(data.events?.by_type).toEqual({ loot: 1 });
    expect(data.events?.top[0]).toMatchObject({ type: 'loot', account: { id: world.main.id } });
    // Two stays: the snapshots are 50 minutes apart, a gap in the trail.
    expect(data.places?.list[0]).toMatchObject({ name: 'Grand Exchange', visits: 2 });
  });

  it('leaves out what the key cannot read, and 404s when it reads none of it', async () => {
    const statsKey = await makeKey(ctx, world.memberId, { categories: ['stats'] });
    const { data } = expectShape(DayResponse, await (await call(statsKey, world.main.id)).json());
    expect(data.gains).toBeDefined();
    expect(data).not.toHaveProperty('sessions');
    expect(data).not.toHaveProperty('events');
    expect(data).not.toHaveProperty('places');

    const liveKey = await makeKey(ctx, world.memberId, { categories: ['location_live'] });
    for (const res of [await call(liveKey, world.main.id), await call(memberKey, RANDOM_ID)]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(ACCOUNT_404);
    }
  });

  it('400 for dates it cannot answer', async () => {
    for (const query of [
      '?date=2026-1-01',
      '?date=2026-11-01&from=2026-11-01&to=2026-11-01',
      '?from=2026-11-01',
      '?from=2026-10-01&to=2026-10-31',
      '?date=2999-01-01',
    ]) {
      const res = await call(memberKey, world.main.id, query);
      expect(res.status, query).toBe(400);
    }
  });
});
