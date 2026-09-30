/**
 * /api/v1 through a service key (D-88, D-89): /me reports the kind, no user and the key's own rate
 * limit (also in X-RateLimit-Limit); /snapshot and /accounts show guild accounts with their owner
 * (D-90) and the account hash (D-91), hide private ones, and keep working after the admin who
 * created the key is offboarded; a user key gets the owner but never the hash.
 */
import { CATEGORIES } from '@hub/core';
import { users } from '@hub/db';
import {
  SERVICE_KEY_RATE_LIMIT,
  createServiceKey,
  offboardUser,
  type ServiceKeyInfo,
} from '@hub/server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AccountResponse,
  AccountsResponse,
  MeResponse,
  SnapshotResponse,
} from '@/lib/api-v1/schemas';
import { setApiLimitsForTests } from '@/lib/api-v1/with-api-key';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { GET as getAccount } from './accounts/[id]/route';
import { GET as getAccounts } from './accounts/route';
import { GET as getMe } from './me/route';
import { GET as getSnapshot } from './snapshot/route';
import {
  ACCOUNT_404,
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
let adminId: string;
let serviceKey: { key: string; info: ServiceKeyInfo };
let ownerKey: TestKey;
let clock: { advance(ms: number): void };

const OWNER_DISCORD_ID = '100000000000000042';

beforeAll(async () => {
  ctx = await withTestDb({ label: 'v1svckeys' });
  world = await seedWorld(ctx);
  await ctx.t.db
    .update(users)
    .set({ discordId: OWNER_DISCORD_ID })
    .where(eq(users.id, world.ownerId));
  adminId = await ctx.seedUser({ name: 'Ada Admin', isAdmin: true });
  serviceKey = await createServiceKey(ctx.t.db, {
    actor: { userId: adminId, status: 'active', isAdmin: true },
    input: { name: 'Guild live map', categories: [...CATEGORIES] },
  });
  ownerKey = await makeKey(ctx, world.ownerId);
  // The alt shares nothing with the guild: only its owner (and their key) may see it.
  for (const c of CATEGORIES) await setAudience(ctx, world.alt.hash, c, 'private');
});
beforeEach(() => {
  clock = freshLimits();
});
afterAll(async () => {
  setApiLimitsForTests();
  await ctx.cleanup();
});

const me = (key: string) => getMe(v1Request(ctx, '/me', { key }));
async function snapshot(key: string) {
  clock.advance(1_000);
  return getSnapshot(v1Request(ctx, '/snapshot', { key }));
}

describe('a service key on /api/v1', () => {
  it('/me: kind service, user null, its own rate limit, also in X-RateLimit-Limit', async () => {
    const res = await me(serviceKey.key);
    expect(res.status).toBe(200);
    expectCors(res);
    expect(res.headers.get('x-ratelimit-limit')).toBe(String(SERVICE_KEY_RATE_LIMIT));
    expect(res.headers.get('x-ratelimit-remaining')).toBe(String(SERVICE_KEY_RATE_LIMIT - 1));
    const body = expectShape(MeResponse, await res.json());
    expect(body.data).toEqual({
      key: {
        id: serviceKey.info.id,
        kind: 'service',
        name: 'Guild live map',
        prefix: serviceKey.info.prefix,
        categories: [...CATEGORIES],
        account_scope: 'all_visible',
        rate_limit_per_minute: SERVICE_KEY_RATE_LIMIT,
        expires_at: null,
      },
      user: null,
      visible_accounts: 1,
    });
    // A user key still reports its creator and the user default.
    const user = expectShape(MeResponse, await (await me(ownerKey.key)).json());
    expect(user.data.key).toMatchObject({ kind: 'user', rate_limit_per_minute: 120 });
    expect(user.data.user).toEqual({ name: 'Owner' });
  });

  it('/snapshot: guild accounts with owner and account_hash; private ones hidden', async () => {
    const res = await snapshot(serviceKey.key);
    expect(res.status).toBe(200);
    const body = expectShape(SnapshotResponse, await res.json());
    expect(body.data.map((a) => a.id)).toEqual([world.main.id]);
    expect(body.data[0]).toMatchObject({
      account_hash: world.main.hash,
      owner: { name: 'Owner', discord_id: OWNER_DISCORD_ID },
      categories: ['stats', 'events', 'activity', 'location_live'],
      online: true,
      location: { x: 3164, y: 3487 },
    });
    expect(body.data[0]).not.toHaveProperty('inventory');
    // The owner's own key sees both accounts, with the owner but without the hash.
    const own = expectShape(SnapshotResponse, await (await snapshot(ownerKey.key)).json());
    expect(own.data.map((a) => a.id).sort()).toEqual([world.alt.id, world.main.id].sort());
    for (const account of own.data) {
      expect(account).not.toHaveProperty('account_hash');
      expect(account.owner).toEqual({ name: 'Owner', discord_id: OWNER_DISCORD_ID });
    }
  });

  it('/accounts and /accounts/{id}: the same identity; the private account is the one 404', async () => {
    const list = expectShape(
      AccountsResponse,
      await (await getAccounts(v1Request(ctx, '/accounts', { key: serviceKey.key }))).json(),
    );
    expect(list.data).toEqual([
      expect.objectContaining({
        id: world.main.id,
        account_hash: world.main.hash,
        owner: { name: 'Owner', discord_id: OWNER_DISCORD_ID },
      }),
    ]);
    const detail = await getAccount(
      v1Request(ctx, `/accounts/${world.main.id}`, { key: serviceKey.key }),
      idParams(world.main.id),
    );
    const { data } = expectShape(AccountResponse, await detail.json());
    expect(data).toMatchObject({ account_hash: world.main.hash, owner: { name: 'Owner' } });
    const hidden = await getAccount(
      v1Request(ctx, `/accounts/${world.alt.id}`, { key: serviceKey.key }),
      idParams(world.alt.id),
    );
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual(ACCOUNT_404);
    const forOwner = expectShape(
      AccountsResponse,
      await (await getAccounts(v1Request(ctx, '/accounts', { key: ownerKey.key }))).json(),
    );
    expect(forOwner.data.every((a) => !('account_hash' in a))).toBe(true);
  });

  it('keeps working after the admin who created it is offboarded', async () => {
    await offboardUser(ctx.t.db, { userId: adminId, reason: 'admin', graceDays: 30 });
    const res = await me(serviceKey.key);
    expect(res.status).toBe(200);
    expect((await res.json()).data.key.id).toBe(serviceKey.info.id);
    // The offboarded owner's key stops at once, and their account (hidden: no contributor to take
    // it over) leaves the guild audience's snapshot.
    await offboardUser(ctx.t.db, { userId: world.ownerId, reason: 'left_guild', graceDays: 30 });
    expect((await me(ownerKey.key)).status).toBe(401);
    const body = expectShape(SnapshotResponse, await (await snapshot(serviceKey.key)).json());
    expect(body.data.map((a) => a.id)).not.toContain(world.main.id);
  });
});
