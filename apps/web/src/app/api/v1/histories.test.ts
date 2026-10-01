/**
 * GET /api/v1/accounts/{id}/sessions, /equipment-history, /wealth and /locations over ingested
 * fixtures: the documented shapes, each history gated by its own category (the one 404, D-70), the
 * default 30-day range and 400 for bad ranges.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EquipmentHistoryResponse,
  LocationsResponse,
  SessionsResponse,
  WealthResponse,
} from '@/lib/api-v1/schemas';
import { setApiLimitsForTests } from '@/lib/api-v1/with-api-key';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { GET as getEquipment } from './accounts/[id]/equipment-history/route';
import { GET as getLocations } from './accounts/[id]/locations/route';
import { GET as getSessions } from './accounts/[id]/sessions/route';
import { GET as getWealth } from './accounts/[id]/wealth/route';
import {
  ACCOUNT_404,
  RANDOM_ID,
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

beforeAll(async () => {
  ctx = await withTestDb({ label: 'v1histories' });
  world = await seedWorld(ctx);
  ownerKey = await makeKey(ctx, world.ownerId);
  memberKey = await makeKey(ctx, world.memberId);
});
beforeEach(() => {
  freshLimits();
});
afterAll(async () => {
  setApiLimitsForTests();
  await ctx.cleanup();
});

type Handler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

function call(handler: Handler, key: TestKey, id: string, query = '') {
  return handler(v1Request(ctx, `/accounts/${id}/x${query}`, { key: key.key }), idParams(id));
}

const DAY = 24 * 60 * 60 * 1000;

describe('history endpoints', () => {
  it('sessions: the open session, newest first, over the last 30 days by default', async () => {
    const res = await call(getSessions, ownerKey, world.main.id);
    expect(res.status).toBe(200);
    const { data } = expectShape(SessionsResponse, await res.json());
    expect(data.account).toEqual({ id: world.main.id, name: world.main.name });
    expect(Date.parse(data.to) - Date.parse(data.from)).toBe(30 * DAY);
    expect(data.sessions.length).toBeGreaterThanOrEqual(1);
    expect(data.sessions[0]).toMatchObject({ ended_at: null, end_reason: null, worlds: [302] });
  });

  it('equipment-history: each change with the whole worn set', async () => {
    const { data } = expectShape(
      EquipmentHistoryResponse,
      await (await call(getEquipment, ownerKey, world.main.id)).json(),
    );
    expect(data.changes.length).toBeGreaterThanOrEqual(1);
    expect(data.changes[0]?.items.map((i) => i.equipment_slot)).toContain('HEAD');
  });

  it('wealth: one entry per UTC day', async () => {
    const { data } = expectShape(
      WealthResponse,
      await (await call(getWealth, ownerKey, world.main.id)).json(),
    );
    expect(data.days.length).toBeGreaterThanOrEqual(1);
    expect(data.days.at(-1)?.max_value).toBeGreaterThan(0);
  });

  it('locations: the trail, oldest first', async () => {
    const { data } = expectShape(
      LocationsResponse,
      await (await call(getLocations, ownerKey, world.main.id)).json(),
    );
    expect(data.points.length).toBeGreaterThanOrEqual(1);
    expect(data.points[0]).toMatchObject({ x: 3164, y: 3487, plane: 0, is_on_boat: false });
  });

  it('honours an explicit range', async () => {
    const from = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data } = expectShape(
      LocationsResponse,
      await (await call(getLocations, ownerKey, world.main.id, `?from=${from}`)).json(),
    );
    expect(data.from).toBe(from);
    expect(data.points.every((p) => Date.parse(p.at) >= Date.parse(from))).toBe(true);
  });

  it('gates each history by its own category: a plain member reads only sessions', async () => {
    // activity stays guild (the default, D-96); the other histories' categories are private.
    for (const category of ['equipment', 'inventory', 'location_history'] as const) {
      await setAudience(ctx, world.main.hash, category, 'private');
    }
    expect((await call(getSessions, memberKey, world.main.id)).status).toBe(200);
    for (const handler of [getEquipment, getWealth, getLocations]) {
      const res = await handler(
        v1Request(ctx, `/accounts/${world.main.id}/x`, { key: memberKey.key }),
        idParams(world.main.id),
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(ACCOUNT_404);
    }
    const unknown = await call(getSessions, ownerKey, RANDOM_ID);
    expect(await unknown.json()).toEqual(ACCOUNT_404);
  });

  it('400 for a malformed range or from after to', async () => {
    for (const query of [
      '?from=yesterday',
      '?to=1700000000',
      '?from=2026-09-29T00:00:00Z&to=2026-09-28T00:00:00Z',
    ]) {
      for (const handler of [getSessions, getEquipment, getWealth, getLocations]) {
        const res = await call(handler, ownerKey, world.main.id, query);
        expect(res.status, query).toBe(400);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
          'invalid_request',
        );
      }
    }
  });
});
