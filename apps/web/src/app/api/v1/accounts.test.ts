/**
 * GET /api/v1/me, /accounts and /accounts/{id} over data ingested from the plugin fixtures: the
 * documented shapes (each body parsed with its response schema), omitted vs "not shared" sections,
 * snake_case keys with data keys passed through, the filters, and the one 404 for everything a key
 * can't read (D-70).
 */
import { MAX_LIST_PARAM } from '@hub/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountResponse, AccountsResponse, MeResponse } from '@/lib/api-v1/schemas';
import { setApiLimitsForTests } from '@/lib/api-v1/with-api-key';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { GET as getAccount } from './accounts/[id]/route';
import { GET as listAccounts } from './accounts/route';
import { GET as getMe } from './me/route';
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
let listKey: TestKey;
let eventsOnlyKey: TestKey;
let memberLiveKey: TestKey;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'v1accounts' });
  world = await seedWorld(ctx);
  // The member reads stats, events and activity here: the rest (guild by default, D-96) is private.
  for (const { hash } of [world.main, world.alt]) {
    for (const category of [
      'location_live',
      'location_history',
      'equipment',
      'inventory',
    ] as const) {
      await setAudience(ctx, hash, category, 'private');
    }
  }
  ownerKey = await makeKey(ctx, world.ownerId, { name: 'owner, everything' });
  memberKey = await makeKey(ctx, world.memberId, { name: 'member, everything' });
  listKey = await makeKey(ctx, world.ownerId, {
    name: 'main only',
    accountScope: 'list',
    accountPublicIds: [world.main.id],
  });
  eventsOnlyKey = await makeKey(ctx, world.ownerId, { name: 'events', categories: ['events'] });
  memberLiveKey = await makeKey(ctx, world.memberId, {
    name: 'live map',
    categories: ['location_live'],
  });
});
beforeEach(() => {
  freshLimits();
});
afterAll(async () => {
  setApiLimitsForTests();
  await ctx.cleanup();
});

async function account(key: TestKey, id: string): Promise<Response> {
  return getAccount(v1Request(ctx, `/accounts/${id}`, { key: key.key }), idParams(id));
}

async function list(key: TestKey, query = ''): Promise<Response> {
  return listAccounts(v1Request(ctx, `/accounts${query}`, { key: key.key }));
}

describe('GET /api/v1/me', () => {
  it('describes the key, its creator and how many accounts it sees', async () => {
    const res = await getMe(v1Request(ctx, '/me', { key: listKey.key }));
    expect(res.status).toBe(200);
    const body = expectShape(MeResponse, await res.json());
    expect(body.data).toEqual({
      key: {
        id: listKey.info.id,
        kind: 'user',
        name: 'main only',
        prefix: listKey.info.prefix,
        categories: listKey.info.categories,
        account_scope: 'list',
        rate_limit_per_minute: 120,
        expires_at: null,
      },
      user: { name: 'Owner' },
      visible_accounts: 1,
    });
    expect(Date.parse(body.meta.generated_at)).not.toBeNaN();
    expect(JSON.stringify(body)).not.toContain(listKey.key.slice(-43));
  });
});

describe('GET /api/v1/accounts', () => {
  it('lists the visible accounts by name with presence for `activity`', async () => {
    const res = await list(ownerKey);
    expect(res.status).toBe(200);
    expectCors(res);
    const body = expectShape(AccountsResponse, await res.json());
    expect(body.data.map((a) => a.name)).toEqual([world.main.name, world.alt.name]);
    expect(body.meta.count).toBe(2);
    const main = body.data[0];
    expect(main).toMatchObject({
      id: world.main.id,
      type: 0,
      type_label: 'Normal',
      online: true,
      world: 302,
    });
    expect(Date.parse(main?.last_seen ?? '')).not.toBeNaN();
  });

  it('gives no presence to a key without `activity`', async () => {
    const body = expectShape(AccountsResponse, await (await list(eventsOnlyKey)).json());
    expect(body.data.map((a) => [a.online, a.world, a.last_seen])).toEqual([
      [null, null, null],
      [null, null, null],
    ]);
  });

  it('filters by names (case-insensitive), ids and online', async () => {
    const byName = expectShape(
      AccountsResponse,
      await (await list(ownerKey, '?names=alpha%20main,Nobody')).json(),
    );
    expect(byName.data.map((a) => a.id)).toEqual([world.main.id]);

    const byId = expectShape(
      AccountsResponse,
      await (await list(ownerKey, `?ids=${world.alt.id},${RANDOM_ID}`)).json(),
    );
    expect(byId.data.map((a) => a.id)).toEqual([world.alt.id]);

    const online = expectShape(
      AccountsResponse,
      await (await list(ownerKey, '?online=true')).json(),
    );
    expect(online.data.map((a) => a.id)).toEqual([world.main.id]);
    const offline = expectShape(
      AccountsResponse,
      await (await list(ownerKey, '?online=false')).json(),
    );
    expect(offline.data.map((a) => a.id)).toEqual([world.alt.id]);

    // Unknown parameters are ignored (additive compatibility).
    expect((await list(ownerKey, '?future_param=1')).status).toBe(200);
  });

  it('only lists what the key may see', async () => {
    const scoped = expectShape(AccountsResponse, await (await list(listKey)).json());
    expect(scoped.data.map((a) => a.id)).toEqual([world.main.id]);
    const live = expectShape(AccountsResponse, await (await list(memberLiveKey)).json());
    expect(live.data).toEqual([]);
  });

  it('400 for malformed filters', async () => {
    const tooMany = Array.from({ length: MAX_LIST_PARAM + 1 }, (_, i) => `id${i}`).join(',');
    for (const query of ['?online=yes', '?ids=a,,b', '?ids=bad!id', `?ids=${tooMany}`]) {
      const res = await list(ownerKey, query);
      expect(res.status, query).toBe(400);
      const body = (await res.json()) as { error: { code: string; details?: unknown[] } };
      expect(body.error.code).toBe('invalid_request');
      expect(body.error.details?.length).toBeGreaterThan(0);
    }
  });
});

describe('GET /api/v1/accounts/{id}', () => {
  it('returns every section to the owner, with snake_case keys and data keys as sent', async () => {
    const res = await account(ownerKey, world.main.id);
    expect(res.status).toBe(200);
    const { data } = expectShape(AccountResponse, await res.json());
    expect(data.categories).toEqual([
      'stats',
      'events',
      'activity',
      'location_live',
      'location_history',
      'equipment',
      'inventory',
      'hiscores',
    ]);
    expect(data.presence).toMatchObject({ shared: true, online: true, world: 302 });
    expect(data.vitals).toMatchObject({ shared: true, hp: { current: 99, max: 99 } });
    expect(data.location).toMatchObject({ shared: true, x: 3164, y: 3487, stale: false });
    if (!data.skills?.shared) throw new Error('skills not shared');
    expect(data.skills.skills[0]?.skill).toBe('Overall');
    expect(data.skills.skills.map((s) => s.skill)).toContain('Attack');
    if (!data.equipment?.shared) throw new Error('equipment not shared');
    // Equipment slots and item names are data: passed through as the plugin spells them.
    expect(data.equipment.items[0]).toEqual({
      id: 10828,
      name: 'Helm of Neitiznot',
      quantity: 1,
      ge_price: 47601,
      ha_price: 30000,
      equipment_slot: 'HEAD',
      inventory_slot: null,
    });
    expect(data.equipment.items.map((i) => i.equipment_slot)).toContain('WEAPON');
    expect(data.inventory).toMatchObject({ shared: true });
  });

  it('marks sections the plugin never sent as not shared (not empty)', async () => {
    const { data } = expectShape(
      AccountResponse,
      await (await account(ownerKey, world.alt.id)).json(),
    );
    expect(data.location).toEqual({ shared: false, updated_at: null });
    expect(data.equipment).toEqual({ shared: false, updated_at: null });
    expect(data.inventory).toEqual({ shared: false, updated_at: null });
    expect(data.skills).toMatchObject({ shared: true });
  });

  it('omits the sections of categories the key or the viewer lacks', async () => {
    const member = expectShape(
      AccountResponse,
      await (await account(memberKey, world.main.id)).json(),
    );
    expect(member.data.categories).toEqual(['stats', 'events', 'activity', 'hiscores']);
    expect(Object.keys(member.data).sort()).toEqual(
      [
        'categories',
        'first_seen',
        'id',
        'name',
        'owner',
        'presence',
        'skills',
        'type',
        'type_label',
        'vitals',
      ].sort(),
    );

    const events = expectShape(
      AccountResponse,
      await (await account(eventsOnlyKey, world.main.id)).json(),
    );
    expect(events.data.categories).toEqual(['events']);
    expect(events.data).not.toHaveProperty('skills');
    expect(events.data).not.toHaveProperty('presence');
  });

  it('answers everything the key can’t read with the body of an unknown id', async () => {
    const unknown = await account(ownerKey, RANDOM_ID);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual(ACCOUNT_404);

    const cases: [string, TestKey, string][] = [
      ['not an id', ownerKey, 'bad!id'],
      ['outside the key scope', listKey, world.alt.id],
      ['no category of the key shared with its creator', memberLiveKey, world.main.id],
    ];
    for (const [label, key, id] of cases) {
      const res = await account(key, id);
      expect(res.status, label).toBe(404);
      expectCors(res);
      expect(await res.json(), label).toEqual(ACCOUNT_404);
    }
  });
});
