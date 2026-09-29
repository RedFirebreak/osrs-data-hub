/**
 * GET /api/v1/accounts/{id}/xp, /xp, /accounts/{id}/gains and /leaderboards/gains over ingested
 * fixtures: the documented shapes, skill names canonicalised (data keys unchanged), the `stats`
 * gate (the one 404, D-70) and 400 for bad parameters.
 */
import { MAX_XP_ACCOUNTS } from '@hub/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GainsResponse,
  LeaderboardsResponse,
  XpMultiResponse,
  XpResponse,
} from '@/lib/api-v1/schemas';
import { setApiLimitsForTests } from '@/lib/api-v1/with-api-key';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { GET as getGains } from './accounts/[id]/gains/route';
import { GET as getAccountXp } from './accounts/[id]/xp/route';
import { GET as getLeaderboards } from './leaderboards/gains/route';
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
import { GET as getXp } from './xp/route';

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  connection: () => Promise.resolve(),
}));

let ctx: WebTestContext;
let world: World;
let ownerKey: TestKey;
let eventsOnlyKey: TestKey;
let listKey: TestKey;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'v1xp' });
  world = await seedWorld(ctx);
  ownerKey = await makeKey(ctx, world.ownerId);
  eventsOnlyKey = await makeKey(ctx, world.ownerId, { name: 'events', categories: ['events'] });
  listKey = await makeKey(ctx, world.ownerId, {
    name: 'main only',
    accountScope: 'list',
    accountPublicIds: [world.main.id],
  });
});
beforeEach(() => {
  freshLimits();
});
afterAll(async () => {
  setApiLimitsForTests();
  await ctx.cleanup();
});

interface ErrorBody {
  error: { code: string; message: string; details?: { path: string; message: string }[] };
}

function accountXp(key: TestKey, id: string, query = '') {
  return getAccountXp(v1Request(ctx, `/accounts/${id}/xp${query}`, { key: key.key }), idParams(id));
}

function gains(key: TestKey, id: string, query = '') {
  return getGains(v1Request(ctx, `/accounts/${id}/gains${query}`, { key: key.key }), idParams(id));
}

describe('GET /api/v1/accounts/{id}/xp', () => {
  it('returns the series of the requested skills, canonically spelled, as [time, xp] pairs', async () => {
    const res = await accountXp(ownerKey, world.main.id, '?skills=attack,OVERALL&resolution=5m');
    expect(res.status).toBe(200);
    const { data } = expectShape(XpResponse, await res.json());
    expect(data.account).toEqual({ id: world.main.id, name: world.main.name });
    expect(data.resolution).toBe('5m');
    expect(data.series.map((s) => s.skill)).toEqual(['Attack', 'Overall']);
    const attack = data.series[0]?.points ?? [];
    expect(attack.length).toBeGreaterThanOrEqual(2);
    const values = attack.map(([, xp]) => xp);
    expect(Math.max(...values) - Math.min(...values)).toBe(ATTACK_GAIN);
    expect(Date.parse(data.to) - Date.parse(data.from)).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('defaults to Overall over the last 7 days', async () => {
    const { data } = expectShape(
      XpResponse,
      await (await accountXp(ownerKey, world.main.id)).json(),
    );
    expect(data.series.map((s) => s.skill)).toEqual(['Overall']);
  });

  it('404 like an unknown id without `stats`, outside the scope, or for no account', async () => {
    for (const [key, id] of [
      [eventsOnlyKey, world.main.id],
      [listKey, world.alt.id],
      [ownerKey, RANDOM_ID],
    ] as const) {
      const res = await accountXp(key, id);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(ACCOUNT_404);
    }
  });

  it('400 for bad parameters', async () => {
    const cases = [
      '?from=yesterday',
      '?to=2026-09-29',
      '?resolution=1m',
      '?skills=Attack,,Overall',
      '?skills=Dancing',
      `?skills=${Array.from({ length: 31 }, (_, i) => `s${i}`).join(',')}`,
      '?from=2026-09-29T00:00:00Z&to=2026-09-28T00:00:00Z',
    ];
    for (const query of cases) {
      const res = await accountXp(ownerKey, world.main.id, query);
      expect(res.status, query).toBe(400);
      expect(((await res.json()) as ErrorBody).error.code, query).toBe('invalid_request');
    }
  });
});

describe('GET /api/v1/xp', () => {
  it('returns one series per account in request order', async () => {
    const res = await getXp(
      v1Request(ctx, `/xp?accounts=${world.alt.id},${world.main.id}&skills=attack`, {
        key: ownerKey.key,
      }),
    );
    expect(res.status).toBe(200);
    const { data } = expectShape(XpMultiResponse, await res.json());
    expect(data.accounts.map((a) => a.account.id)).toEqual([world.alt.id, world.main.id]);
    expect(data.accounts.every((a) => a.series[0]?.skill === 'Attack')).toBe(true);
  });

  it('404 naming an account the key can’t read, like an unknown one', async () => {
    const res = await getXp(
      v1Request(ctx, `/xp?accounts=${world.main.id},${world.alt.id}`, { key: listKey.key }),
    );
    expect(res.status).toBe(404);
    const unknown = await getXp(
      v1Request(ctx, `/xp?accounts=${world.main.id},${RANDOM_ID}`, { key: ownerKey.key }),
    );
    expect(unknown.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error).toEqual({
      code: 'not_found',
      message: `account ${world.alt.id} not found`,
    });
    expect(((await unknown.json()) as ErrorBody).error).toEqual({
      code: 'not_found',
      message: `account ${RANDOM_ID} not found`,
    });
  });

  it('400 without accounts, with too many, or with a malformed id', async () => {
    const tooMany = Array.from({ length: MAX_XP_ACCOUNTS + 1 }, (_, i) => `acc${i}`).join(',');
    for (const query of ['', '?accounts=', `?accounts=${tooMany}`, '?accounts=bad!id']) {
      const res = await getXp(v1Request(ctx, `/xp${query}`, { key: ownerKey.key }));
      expect(res.status, query).toBe(400);
      expect(((await res.json()) as ErrorBody).error.details?.[0]?.path, query).toMatch(
        /^accounts(\.\d+)?$/,
      );
    }
  });
});

describe('GET /api/v1/accounts/{id}/gains', () => {
  it('returns every skill with its gain for the day, Overall first', async () => {
    const res = await gains(ownerKey, world.main.id);
    expect(res.status).toBe(200);
    const { data } = expectShape(GainsResponse, await res.json());
    expect(data.period).toBe('day');
    expect(data.gains[0]?.skill).toBe('Overall');
    expect(data.gains.find((g) => g.skill === 'Attack')?.xp).toBe(ATTACK_GAIN);
    expect(data.gains.find((g) => g.skill === 'Defence')?.xp).toBe(0);
  });

  it('takes a period or an explicit range', async () => {
    const week = expectShape(
      GainsResponse,
      await (await gains(ownerKey, world.main.id, '?period=week')).json(),
    );
    expect(week.data.period).toBe('week');
    const from = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const range = expectShape(
      GainsResponse,
      await (await gains(ownerKey, world.main.id, `?from=${from}`)).json(),
    );
    expect(range.data.period).toBeNull();
    expect(range.data.gains.find((g) => g.skill === 'Attack')?.xp).toBe(ATTACK_GAIN);
  });

  it('400 for a bad period, both a period and a range, or `to` alone', async () => {
    const at = '2026-09-28T00:00:00Z';
    for (const query of ['?period=decade', `?period=week&from=${at}`, `?to=${at}`]) {
      const res = await gains(ownerKey, world.main.id, query);
      expect(res.status, query).toBe(400);
    }
  });

  it('404 without `stats`', async () => {
    const res = await gains(eventsOnlyKey, world.main.id);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(ACCOUNT_404);
  });
});

describe('GET /api/v1/leaderboards/gains', () => {
  it('ranks the accounts that gained XP', async () => {
    const res = await getLeaderboards(
      v1Request(ctx, '/leaderboards/gains?skill=attack', { key: ownerKey.key }),
    );
    expect(res.status).toBe(200);
    const { data } = expectShape(LeaderboardsResponse, await res.json());
    expect(data.period).toBe('day');
    expect(data.leaderboards).toEqual([
      {
        skill: 'Attack',
        entries: [
          { rank: 1, account: { id: world.main.id, name: world.main.name }, gain: ATTACK_GAIN },
        ],
      },
    ]);
  });

  it('shows Overall first without a skill, and nothing to a key without `stats`', async () => {
    const all = expectShape(
      LeaderboardsResponse,
      await (
        await getLeaderboards(
          v1Request(ctx, '/leaderboards/gains?period=week', { key: ownerKey.key }),
        )
      ).json(),
    );
    expect(all.data.leaderboards[0]?.skill).toBe('Overall');
    const none = expectShape(
      LeaderboardsResponse,
      await (
        await getLeaderboards(v1Request(ctx, '/leaderboards/gains', { key: eventsOnlyKey.key }))
      ).json(),
    );
    expect(none.data.leaderboards.every((b) => b.entries.length === 0)).toBe(true);
  });

  it('400 for an unknown skill or period', async () => {
    for (const query of ['?skill=dancing', '?period=year', '?skill=']) {
      const res = await getLeaderboards(
        v1Request(ctx, `/leaderboards/gains${query}`, { key: ownerKey.key }),
      );
      expect(res.status, query).toBe(400);
    }
  });
});
