/**
 * GET /api/v1/accounts/{id}/collection-log and GET /api/v1/collection-log (D-131): the collection
 * log through a key, with data sent the way the plugin sends it: a loot drop and the collection log
 * slot it filled in one payload. The wire shape, the meta fields, the one 404 (D-70), the 400s, and
 * who has an item for a user key and a service key.
 */
import { accountHiscores, osrsAccounts } from '@hub/db';
import { createServiceKey } from '@hub/server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountCollectionLogResponse, CollectionLogResponse } from '@/lib/api-v1/schemas';
import { setApiLimitsForTests } from '@/lib/api-v1/with-api-key';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { GET as getAccountLog } from './accounts/[id]/collection-log/route';
import { GET as getGuildLog } from './collection-log/route';
import {
  ACCOUNT_404,
  RANDOM_ID,
  expectCors,
  expectShape,
  fixture,
  freshLimits,
  idParams,
  ingest,
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
let memberKey: TestKey;
let statsOnlyKey: TestKey;
let serviceKey: string;
let loggedAt: string;
const FETCHED = new Date('2026-10-09T11:00:00Z');

beforeAll(async () => {
  ctx = await withTestDb({ label: 'v1clog' });
  world = await seedWorld(ctx);
  memberKey = await makeKey(ctx, world.memberId);
  statsOnlyKey = await makeKey(ctx, world.memberId, { categories: ['stats'] });
  const adminId = await ctx.seedUser({ name: 'Admin', isAdmin: true });
  serviceKey = (
    await createServiceKey(ctx.t.db, {
      actor: { userId: adminId, status: 'active', isAdmin: true },
      input: { name: 'bot', categories: ['events', 'hiscores'] },
    })
  ).key;

  // Kree'arra's drop and the slot it filled, in one payload as the plugin sends them.
  const body = fixture('snapshot-normal', { hash: world.main.hash, name: world.main.name });
  body.events = [
    ...(fixture('event-loot').events ?? []),
    ...(fixture('event-collectionlog').events ?? []),
  ];
  const at = new Date(Date.now() - 10_000);
  await ingest(world.device.token, body, at);
  loggedAt = new Date(at.getTime() - 2_000).toISOString();

  const [main] = await ctx.t.db
    .select({ id: osrsAccounts.id })
    .from(osrsAccounts)
    .where(eq(osrsAccounts.accountHash, world.main.hash));
  await ctx.t.db.insert(accountHiscores).values({
    accountId: main!.id,
    lookupName: world.main.name,
    mode: 'regular',
    status: 'ok',
    lastAttemptAt: FETCHED,
    fetchedAt: FETCHED,
    main: {
      skills: [{ name: 'Overall', rank: 9000, level: 1500, xp: 4_800_000_000 }],
      activities: [{ name: 'Collections Logged', rank: 4321, score: 612 }],
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

const account = (key: string, id: string, query = '') =>
  getAccountLog(v1Request(ctx, `/accounts/${id}/collection-log${query}`, { key }), idParams(id));
const guild = (key: string, query = '') =>
  getGuildLog(v1Request(ctx, `/collection-log${query}`, { key }));

const SLOT = () => ({
  item: 'Tanzanite fang',
  item_id: 12922,
  kill_count: 212,
  value_gp: 10_221_949,
  logged_at: loggedAt,
  source: "Kree'arra",
});

describe('GET /api/v1/accounts/{id}/collection-log', () => {
  it('returns the hiscores total and the slots seen, with the drop they came with', async () => {
    const res = await account(memberKey.key, world.main.id);
    expect(res.status).toBe(200);
    expectCors(res);
    const body = expectShape(AccountCollectionLogResponse, await res.json());
    expect(body.data).toEqual({
      account: { id: world.main.id, name: world.main.name },
      total: {
        logged: 612,
        rank: 4321,
        mode_rank: null,
        mode: 'regular',
        fetched_at: FETCHED.toISOString(),
        gained_30d: 0,
      },
      slots: [SLOT()],
      groups: [{ source: "Kree'arra", count: 1 }],
    });
    expect(body.meta).toMatchObject({ count: 1, truncated: false });
  });

  it('filters by source, and leaves the slots out without `events`', async () => {
    const none = expectShape(
      AccountCollectionLogResponse,
      await (await account(memberKey.key, world.main.id, '?source=zulrah&limit=5')).json(),
    );
    expect(none.data.slots).toEqual([]);
    expect(none.data.groups).toEqual([]);

    await setAudience(ctx, world.main.hash, 'events', 'private');
    try {
      const { data } = expectShape(
        AccountCollectionLogResponse,
        await (await account(memberKey.key, world.main.id)).json(),
      );
      expect(data.slots).toBeNull();
      expect(data.total?.logged).toBe(612);
    } finally {
      await setAudience(ctx, world.main.hash, 'events', 'guild');
    }
  });

  it('is the one 404 without `events` and `hiscores`, or for an unknown id', async () => {
    for (const [key, id] of [
      [statsOnlyKey.key, world.main.id],
      [memberKey.key, RANDOM_ID],
    ] as const) {
      const res = await account(key, id);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(ACCOUNT_404);
    }
  });

  it('answers 400 to a bad limit or since', async () => {
    for (const q of ['?limit=0', '?limit=501', '?since=yesterday', '?source=']) {
      expect((await account(memberKey.key, world.main.id, q)).status, q).toBe(400);
    }
  });
});

describe('GET /api/v1/collection-log', () => {
  it('returns the board and the newest slots, and counts the accounts searched', async () => {
    const res = await guild(memberKey.key);
    expect(res.status).toBe(200);
    expectCors(res);
    const body = expectShape(CollectionLogResponse, await res.json());
    expect(body.data.board).toEqual([
      {
        account: { id: world.main.id, name: world.main.name },
        logged: 612,
        gained_30d: 0,
        seen: 1,
        latest: { item: 'Tanzanite fang', item_id: 12922, logged_at: loggedAt },
      },
    ]);
    expect(body.data.recent).toEqual([
      { account: { id: world.main.id, name: world.main.name }, ...SLOT() },
    ]);
    expect(body.data.items).toBeNull();
    expect(body.meta).toMatchObject({ searchable: 2, truncated: false });
  });

  it('answers who has an item, for a member and for a service key', async () => {
    for (const key of [memberKey.key, serviceKey]) {
      const { data } = expectShape(
        CollectionLogResponse,
        await (await guild(key, '?item=tanzanite%20FANG')).json(),
      );
      expect(data.items).toEqual([
        {
          item: 'Tanzanite fang',
          item_id: 12922,
          holders: [
            {
              account: { id: world.main.id, name: world.main.name },
              logged_at: loggedAt,
              kill_count: 212,
            },
          ],
        },
      ]);
    }
    const { data } = expectShape(
      CollectionLogResponse,
      await (await guild(memberKey.key, '?item=twisted%20bow')).json(),
    );
    expect(data.items).toEqual([]);
  });

  it('narrows to `accounts`, and 404s on one it can’t list', async () => {
    const { data, meta } = expectShape(
      CollectionLogResponse,
      await (await guild(memberKey.key, `?accounts=${world.alt.id}&item=fang`)).json(),
    );
    expect(data.items).toEqual([]);
    expect(meta.searchable).toBe(1);
    const res = await guild(memberKey.key, `?accounts=${world.main.id},${RANDOM_ID}`);
    expect(res.status).toBe(404);
    expect((await guild(statsOnlyKey.key, `?accounts=${world.main.id}`)).status).toBe(404);
  });

  it('answers 400 to a lookup too short or too long, and a bad limit', async () => {
    for (const q of ['?item=a', `?item=${'x'.repeat(65)}`, '?limit=0', '?limit=x']) {
      expect((await guild(memberKey.key, q)).status, q).toBe(400);
    }
  });
});
