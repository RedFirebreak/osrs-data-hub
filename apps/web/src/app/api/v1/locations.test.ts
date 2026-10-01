/**
 * GET /api/v1/locations?accounts=a,b (D-92): every named account's trail in one call, the same
 * points as /accounts/{id}/locations, the `location_history` gate (the one 404, D-70), the bulk
 * caps per key kind, and 400 for bad parameters.
 */
import { MAX_BULK_ACCOUNTS, MAX_BULK_ACCOUNTS_SERVICE, createServiceKey } from '@hub/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocationsMultiResponse, LocationsResponse } from '@/lib/api-v1/schemas';
import { setApiLimitsForTests } from '@/lib/api-v1/with-api-key';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { GET as getLocations } from './accounts/[id]/locations/route';
import { GET as getLocationsMulti } from './locations/route';
import {
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
let serviceKey: string;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'v1locations' });
  world = await seedWorld(ctx);
  ownerKey = await makeKey(ctx, world.ownerId);
  memberKey = await makeKey(ctx, world.memberId);
  const adminId = await ctx.seedUser({ name: 'Admin', isAdmin: true });
  serviceKey = (
    await createServiceKey(ctx.t.db, {
      actor: { userId: adminId, status: 'active', isAdmin: true },
      input: { name: 'map', categories: ['location_history'] },
    })
  ).key;
});
beforeEach(() => {
  freshLimits();
});
afterAll(async () => {
  setApiLimitsForTests();
  await ctx.cleanup();
});

const multi = (key: string, query: string) =>
  getLocationsMulti(v1Request(ctx, `/locations${query}`, { key }));

const fakeIds = (n: number) =>
  Array.from({ length: n }, (_, i) => `Fake${String(i).padStart(8, '0')}`).join(',');

describe('GET /api/v1/locations', () => {
  it('returns each account’s trail in request order, exactly as the per-account endpoint', async () => {
    const res = await multi(ownerKey.key, `?accounts=${world.alt.id},${world.main.id}`);
    expect(res.status).toBe(200);
    expectCors(res);
    const { data } = expectShape(LocationsMultiResponse, await res.json());
    expect(data.accounts.map((a) => a.account)).toEqual([
      { id: world.alt.id, name: world.alt.name },
      { id: world.main.id, name: world.main.name },
    ]);
    const single = expectShape(
      LocationsResponse,
      await (
        await getLocations(
          v1Request(ctx, `/accounts/${world.main.id}/locations`, { key: ownerKey.key }),
          idParams(world.main.id),
        )
      ).json(),
    );
    expect(data.accounts[1]?.points).toEqual(single.data.points);
    expect(single.data.points.length).toBeGreaterThanOrEqual(1);
    expect(data.accounts[0]?.points).toEqual([]);
    expect(Date.parse(data.to) - Date.parse(data.from)).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('honours an explicit range', async () => {
    const from = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data } = expectShape(
      LocationsMultiResponse,
      await (await multi(ownerKey.key, `?accounts=${world.main.id}&from=${from}`)).json(),
    );
    expect(data.from).toBe(from);
    expect(data.accounts[0]?.points.every((p) => Date.parse(p.at) >= Date.parse(from))).toBe(true);
  });

  it('is the one 404 for any account whose location_history the key can’t read', async () => {
    // A plain member doesn't get a private trail (it is guild by default, D-96) ...
    await setAudience(ctx, world.main.hash, 'location_history', 'private');
    const member = await multi(memberKey.key, `?accounts=${world.main.id}`);
    expect(member.status).toBe(404);
    // A list parameter's 404 names the id, as /xp does (unknown and unreadable alike, D-70).
    expect(await member.json()).toEqual({
      error: { code: 'not_found', message: `account ${world.main.id} not found` },
    });
    // ... nor does a service key, until the owner shares it with the guild.
    expect((await multi(serviceKey, `?accounts=${world.main.id}`)).status).toBe(404);
    await setAudience(ctx, world.main.hash, 'location_history', 'guild');
    const shared = await multi(serviceKey, `?accounts=${world.main.id}`);
    expect(shared.status).toBe(200);
    expect(expectShape(LocationsMultiResponse, await shared.json()).data.accounts).toHaveLength(1);
    // One unknown id fails the whole request.
    const mixed = await multi(ownerKey.key, `?accounts=${world.main.id},${RANDOM_ID}`);
    expect(mixed.status).toBe(404);
    expect(await mixed.json()).toEqual({
      error: { code: 'not_found', message: `account ${RANDOM_ID} not found` },
    });
  });

  it(`caps the list at ${MAX_BULK_ACCOUNTS} accounts for a user key and ${MAX_BULK_ACCOUNTS_SERVICE} for a service key`, async () => {
    const overUser = await multi(ownerKey.key, `?accounts=${fakeIds(MAX_BULK_ACCOUNTS + 1)}`);
    expect(overUser.status).toBe(400);
    expect(((await overUser.json()) as { error: { message: string } }).error.message).toContain(
      String(MAX_BULK_ACCOUNTS),
    );
    // The same list is fine for a service key (then the unknown ids are the 404).
    expect((await multi(serviceKey, `?accounts=${fakeIds(MAX_BULK_ACCOUNTS + 1)}`)).status).toBe(
      404,
    );
    const overService = await multi(
      serviceKey,
      `?accounts=${fakeIds(MAX_BULK_ACCOUNTS_SERVICE + 1)}`,
    );
    expect(overService.status).toBe(400);
  });

  it('400 without accounts, for an empty list, or a malformed range', async () => {
    for (const query of ['', '?accounts=', `?accounts=${world.main.id}&from=yesterday`]) {
      const res = await multi(ownerKey.key, query);
      expect(res.status, query).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'invalid_request',
      );
    }
  });
});
