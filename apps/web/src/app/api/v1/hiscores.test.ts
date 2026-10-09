/**
 * GET /api/v1/accounts/{id}/hiscores and GET /api/v1/hiscores (D-105): what the hub read from the
 * official hiscores, the `hiscores` gate (the one 404, D-70), the bulk form, and `pending` before an
 * account's first lookup.
 */
import { accountHiscores, osrsAccounts } from '@hub/db';
import { createServiceKey } from '@hub/server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HiscoresMultiResponse, HiscoresResponse } from '@/lib/api-v1/schemas';
import { setApiLimitsForTests } from '@/lib/api-v1/with-api-key';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { GET as getAccountHiscores } from './accounts/[id]/hiscores/route';
import { GET as getHiscores } from './hiscores/route';
import {
  ACCOUNT_404,
  RANDOM_ID,
  expectCors,
  expectShape,
  freshLimits,
  idParams,
  makeKey,
  seedWorld,
  setAudience,
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
let ownerKey: TestKey;
let memberKey: TestKey;
let statsOnlyKey: TestKey;
let serviceKey: string;
const FETCHED = new Date('2026-10-09T11:00:00Z');

beforeAll(async () => {
  ctx = await withTestDb({ label: 'v1hiscores' });
  world = await seedWorld(ctx);
  ownerKey = await makeKey(ctx, world.ownerId);
  memberKey = await makeKey(ctx, world.memberId);
  statsOnlyKey = await makeKey(ctx, world.memberId, { categories: ['stats'] });
  const adminId = await ctx.seedUser({ name: 'Admin', isAdmin: true });
  serviceKey = (
    await createServiceKey(ctx.t.db, {
      actor: { userId: adminId, status: 'active', isAdmin: true },
      input: { name: 'map', categories: ['activity', 'hiscores'] },
    })
  ).key;
  const [main] = await ctx.t.db
    .select({ id: osrsAccounts.id })
    .from(osrsAccounts)
    .where(eq(osrsAccounts.accountHash, world.main.hash));
  await ctx.t.db.insert(accountHiscores).values({
    accountId: main!.id,
    lookupName: world.main.name,
    mode: 'ironman',
    status: 'ok',
    lastAttemptAt: FETCHED,
    fetchedAt: FETCHED,
    main: {
      skills: [
        { name: 'Overall', rank: 9000, level: 1500, xp: 4_800_000_000 },
        { name: 'Sailing', rank: null, level: 1, xp: null },
      ],
      activities: [
        { name: 'Grid Points', rank: null, score: null },
        { name: 'Clue Scrolls (all)', rank: 40, score: 300 },
        { name: 'Zulrah', rank: 1200, score: 512 },
        { name: 'Brutus', rank: null, score: 0 },
      ],
    },
    modeTable: {
      skills: [{ name: 'Overall', rank: 70, level: 1500, xp: 4_800_000_000 }],
      activities: [{ name: 'Zulrah', rank: 8, score: 512 }],
    },
  });
});
beforeEach(() => {
  freshLimits();
});
afterAll(async () => {
  setApiLimitsForTests();
  await ctx.cleanup();
});

const one = (key: string, id: string) =>
  getAccountHiscores(v1Request(ctx, `/accounts/${id}/hiscores`, { key }), idParams(id));
const many = (key: string, query = '') => getHiscores(v1Request(ctx, `/hiscores${query}`, { key }));

const MAIN_DATA = () => ({
  account: { id: world.main.id, name: world.main.name },
  status: 'ok',
  fetched_at: FETCHED.toISOString(),
  mode: 'ironman',
  skills: [
    { skill: 'Overall', level: 1500, xp: 4_800_000_000, rank: 9000, mode_rank: 70 },
    { skill: 'Sailing', level: 1, xp: null, rank: null, mode_rank: null },
  ],
  activities: [
    { activity: 'Clue Scrolls (all)', kind: 'clue', score: 300, rank: 40, mode_rank: null },
    { activity: 'Zulrah', kind: 'boss', score: 512, rank: 1200, mode_rank: 8 },
  ],
});

describe('GET /api/v1/accounts/{id}/hiscores', () => {
  it('returns the tables, the iron ranks beside the main ones, and only scored activities', async () => {
    const res = await one(memberKey.key, world.main.id);
    expect(res.status).toBe(200);
    expectCors(res);
    expect(expectShape(HiscoresResponse, await res.json()).data).toEqual(MAIN_DATA());
  });

  it('cuts fetched_at to the UTC day for a key without `activity` (D-50)', async () => {
    const key = await makeKey(ctx, world.memberId, { categories: ['hiscores'] });
    const { data } = expectShape(
      HiscoresResponse,
      await (await one(key.key, world.main.id)).json(),
    );
    expect(data.fetched_at).toBe('2026-10-09T00:00:00.000Z');
  });

  it('says pending for an account never looked up', async () => {
    const { data } = expectShape(
      HiscoresResponse,
      await (await one(memberKey.key, world.alt.id)).json(),
    );
    expect(data).toEqual({
      account: { id: world.alt.id, name: world.alt.name },
      status: 'pending',
      fetched_at: null,
      mode: 'regular',
      skills: [],
      activities: [],
    });
  });

  it('is the one 404 without `hiscores` on the key or on the account', async () => {
    for (const [key, id] of [
      [statsOnlyKey.key, world.main.id],
      [memberKey.key, RANDOM_ID],
    ] as const) {
      const res = await one(key, id);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(ACCOUNT_404);
    }
    await setAudience(ctx, world.main.hash, 'hiscores', 'private');
    try {
      expect((await one(memberKey.key, world.main.id)).status).toBe(404);
      expect((await one(ownerKey.key, world.main.id)).status).toBe(200);
    } finally {
      await setAudience(ctx, world.main.hash, 'hiscores', 'guild');
    }
  });
});

describe('GET /api/v1/hiscores', () => {
  it('without accounts, returns every account whose hiscores the key reads, by name', async () => {
    const res = await many(serviceKey);
    expect(res.status).toBe(200);
    const body = expectShape(HiscoresMultiResponse, await res.json());
    expect(body.meta.count).toBe(2);
    expect(body.data.map((h) => h.account.name)).toEqual([world.main.name, world.alt.name]);
    expect(body.data[0]).toEqual(MAIN_DATA());

    await setAudience(ctx, world.alt.hash, 'hiscores', 'private');
    try {
      const { data } = expectShape(HiscoresMultiResponse, await (await many(serviceKey)).json());
      expect(data.map((h) => h.account.id)).toEqual([world.main.id]);
    } finally {
      await setAudience(ctx, world.alt.hash, 'hiscores', 'guild');
    }
  });

  it('with accounts, returns them in request order, and 404s on one it can’t read', async () => {
    const { data } = expectShape(
      HiscoresMultiResponse,
      await (await many(memberKey.key, `?accounts=${world.alt.id},${world.main.id}`)).json(),
    );
    expect(data.map((h) => h.account.id)).toEqual([world.alt.id, world.main.id]);

    const res = await many(memberKey.key, `?accounts=${world.main.id},${RANDOM_ID}`);
    expect(res.status).toBe(404);
    expect((await many(statsOnlyKey.key, `?accounts=${world.main.id}`)).status).toBe(404);
    expect((await many(statsOnlyKey.key)).status).toBe(200);
  });

  it('caps the accounts at 10 for a user key', async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `Fake${String(i).padStart(8, '0')}`);
    const res = await many(memberKey.key, `?accounts=${ids.join(',')}`);
    expect(res.status).toBe(400);
  });
});
