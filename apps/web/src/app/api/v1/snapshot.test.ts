/**
 * GET /api/v1/snapshot (D-74): every visible account's state by category (omitted vs null), the weak
 * ETag with If-None-Match → 304 (headers, no body), a new ETag after an ingest, `since`, and the
 * caching headers.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SnapshotResponse } from '@/lib/api-v1/schemas';
import { setApiLimitsForTests } from '@/lib/api-v1/with-api-key';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { GET } from './snapshot/route';
import {
  ATTACK_GAIN,
  expectCors,
  expectShape,
  fixture,
  freshLimits,
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
let ownerKey: TestKey;
let memberKey: TestKey;
let mapKey: TestKey;
let clock: { advance(ms: number): void };

beforeAll(async () => {
  ctx = await withTestDb({ label: 'v1snapshot' });
  world = await seedWorld(ctx);
  ownerKey = await makeKey(ctx, world.ownerId);
  memberKey = await makeKey(ctx, world.memberId);
  mapKey = await makeKey(ctx, world.ownerId, {
    name: 'live map',
    categories: ['activity', 'location_live'],
  });
});
beforeEach(() => {
  clock = freshLimits();
});
afterAll(async () => {
  setApiLimitsForTests();
  await ctx.cleanup();
});

/** One snapshot request, a second after the previous one (the 1/s limit). */
async function snapshot(key: TestKey, query = '', headers: Record<string, string> = {}) {
  clock.advance(1_000);
  return GET(v1Request(ctx, `/snapshot${query}`, { key: key.key, headers }));
}

describe('GET /api/v1/snapshot', () => {
  it('returns every visible account with its sections, a weak ETag and private, no-cache', async () => {
    const res = await snapshot(ownerKey);
    expect(res.status).toBe(200);
    expectCors(res);
    expect(res.headers.get('etag')).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    expect(res.headers.get('last-modified')).toMatch(/GMT$/);
    const body = expectShape(SnapshotResponse, await res.json());
    expect(body.meta.count).toBe(2);
    expect(Date.parse(body.meta.last_modified ?? '')).not.toBeNaN();
    const [main, alt] = body.data;
    expect(main).toMatchObject({
      id: world.main.id,
      name: world.main.name,
      online: true,
      world: 302,
      special_world: false,
      game_state: 'LOGGED_IN',
      hp: { current: 99, max: 99 },
      location: { x: 3164, y: 3487, plane: 0, is_on_boat: false, stale: false },
    });
    expect(main?.skills?.skills[0]?.skill).toBe('Overall');
    expect(main?.inventory?.items.length).toBeGreaterThan(0);
    // Readable but never sent by the plugin: null, not omitted.
    expect(alt).toMatchObject({
      id: world.alt.id,
      location: null,
      inventory: null,
      equipment: null,
    });
  });

  it('omits the fields of categories the key or the viewer lacks', async () => {
    // No location category for the member: live location isn't shared (it is by default, D-82).
    await setAudience(ctx, world.main.hash, 'location_live', 'private');
    const member = expectShape(SnapshotResponse, await (await snapshot(memberKey)).json());
    const main = member.data.find((a) => a.id === world.main.id);
    expect(main?.categories).toEqual(['stats', 'events', 'activity']);
    expect(main).not.toHaveProperty('location');
    expect(main).not.toHaveProperty('inventory');
    expect(main).toHaveProperty('online', true);

    const map = expectShape(SnapshotResponse, await (await snapshot(mapKey)).json());
    const mapMain = map.data.find((a) => a.id === world.main.id);
    expect(Object.keys(mapMain ?? {}).sort()).toEqual(
      [
        'categories',
        'game_state',
        'hp',
        'id',
        'last_seen',
        'location',
        'name',
        'online',
        'owner',
        'prayer',
        'special_world',
        'spellbook',
        'type',
        'type_label',
        'world',
      ].sort(),
    );

    // Presence, `game_state` included, belongs to `activity`.
    const statsKey = await makeKey(ctx, world.ownerId, { name: 'stats', categories: ['stats'] });
    const stats = expectShape(SnapshotResponse, await (await snapshot(statsKey)).json());
    const statsMain = stats.data.find((a) => a.id === world.main.id);
    expect(statsMain?.categories).toEqual(['stats']);
    for (const field of ['online', 'world', 'special_world', 'game_state', 'last_seen']) {
      expect(statsMain).not.toHaveProperty(field);
    }
  });

  it('answers If-None-Match with the current ETag with 304: headers, no body', async () => {
    const first = await snapshot(ownerKey);
    const etag = first.headers.get('etag') ?? '';
    const res = await snapshot(ownerKey, '', { 'if-none-match': etag });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
    expect(res.headers.get('etag')).toBe(etag);
    expectCors(res);
    expect(res.headers.get('x-ratelimit-limit')).toBe('120');
    expect(res.headers.get('x-ratelimit-remaining')).toMatch(/^\d+$/);
    // A list with the tag in it, or the strong form, matches too (weak comparison).
    const strong = etag.replace(/^W\//, '');
    expect((await snapshot(ownerKey, '', { 'if-none-match': `"x", ${strong}` })).status).toBe(304);
    expect((await snapshot(ownerKey, '', { 'if-none-match': 'W/"other"' })).status).toBe(200);
  });

  it('changes its ETag when new data arrives', async () => {
    const before = (await snapshot(ownerKey)).headers.get('etag') ?? '';
    const body = fixture('snapshot-normal', { hash: world.main.hash, name: world.main.name });
    if (body.player?.health) body.player.health.current = 42;
    // Keep the XP seedWorld reached: a payload whose XP went down isn't applied (D-24).
    const attack = body.player?.stats?.skills.Attack;
    if (attack) attack.xp += ATTACK_GAIN;
    await ingest(world.device.token, body);

    const res = await snapshot(ownerKey, '', { 'if-none-match': before });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).not.toBe(before);
    const snap = expectShape(SnapshotResponse, await res.json());
    expect(snap.data.find((a) => a.id === world.main.id)?.hp).toEqual({ current: 42, max: 99 });
  });

  it('with `since`, returns only the accounts changed after it', async () => {
    const full = expectShape(SnapshotResponse, await (await snapshot(ownerKey)).json());
    const since = full.meta.last_modified ?? '';
    const changed = expectShape(
      SnapshotResponse,
      await (await snapshot(ownerKey, `?since=${encodeURIComponent(since)}`)).json(),
    );
    // The main account changed seconds ago; the alt 40 minutes ago.
    expect(changed.data.map((a) => a.id)).toEqual([world.main.id]);
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const none = expectShape(
      SnapshotResponse,
      await (await snapshot(ownerKey, `?since=${future}`)).json(),
    );
    expect(none.data).toEqual([]);
    expect(none.meta.count).toBe(0);
  });

  it('400 for a malformed since', async () => {
    const res = await snapshot(ownerKey, '?since=5%20minutes%20ago');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: { path: string }[] } };
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.details[0]?.path).toBe('since');
  });
});
