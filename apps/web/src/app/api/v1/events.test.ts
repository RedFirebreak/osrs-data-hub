/**
 * GET /api/v1/events (D-73): the cursor feed end to end over ingested fixtures — the first page,
 * `cursor=now`, following the cursor, events younger than the settle margin held back, paging with
 * `limit`, the filters, the `events` gate and 400s. Event `data` passes through unchanged (D-77).
 * Also GET /api/v1/leaderboards/loot (D-94), whose entries are these same events.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventsResponse, LootLeaderboardResponse } from '@/lib/api-v1/schemas';
import { setApiLimitsForTests } from '@/lib/api-v1/with-api-key';
import { withTestDb, type WebTestContext } from '@/lib/test-utils';
import { GET } from './events/route';
import { GET as getLootLeaderboard } from './leaderboards/loot/route';
import {
  ATTACK_GAIN,
  RANDOM_ID,
  expectShape,
  fixture,
  freshLimits,
  ingest,
  makeKey,
  seedWorld,
  settleEvents,
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
let statsKey: TestKey;

beforeAll(async () => {
  ctx = await withTestDb({ label: 'v1events' });
  world = await seedWorld(ctx);
  await settleEvents(ctx);
  ownerKey = await makeKey(ctx, world.ownerId);
  memberKey = await makeKey(ctx, world.memberId);
  statsKey = await makeKey(ctx, world.ownerId, { name: 'stats', categories: ['stats'] });
});
beforeEach(() => {
  freshLimits();
});
afterAll(async () => {
  setApiLimitsForTests();
  await ctx.cleanup();
});

async function page(key: TestKey, query = '') {
  const res = await GET(v1Request(ctx, `/events${query}`, { key: key.key }));
  expect(res.status, query).toBe(200);
  return expectShape(EventsResponse, await res.json());
}

/** The main account levels up (event-levelup-multi's events in a snapshot), received now. */
async function levelUp(): Promise<void> {
  const body = fixture('snapshot-normal', { hash: world.main.hash, name: world.main.name });
  const attack = body.player?.stats?.skills.Attack;
  if (attack) attack.xp += ATTACK_GAIN;
  body.events = fixture('event-levelup-multi').events ?? [];
  await ingest(world.device.token, body);
}

describe('GET /api/v1/events', () => {
  let loot: string;

  it('starts with the newest events and a cursor after them; data passes through unchanged', async () => {
    const first = await page(ownerKey);
    expect(first.data.map((e) => e.type)).toEqual(['loot']);
    expect(first.meta.count).toBe(1);
    expect(first.meta.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const [event] = first.data;
    loot = event?.id ?? '';
    expect(event).toMatchObject({
      account: { id: world.main.id, name: world.main.name },
      type: 'loot',
      special_world: false,
      title: expect.any(String) as string,
      line: expect.stringContaining(world.main.name) as string,
    });
    expect(event?.value_gp).toBeGreaterThan(0);
    // The plugin's event object, camelCase keys and all: data, not keys the hub defines.
    expect(event?.data).toMatchObject({ type: 'loot', eventId: expect.any(String) as string });
    const items = (event?.data.data as { items?: Record<string, unknown>[] }).items ?? [];
    expect(items[0]).toHaveProperty('gePrice');
    // Its cursor is the current one: nothing newer has settled.
    expect((await page(ownerKey, '?cursor=now')).meta.next_cursor).toBe(first.meta.next_cursor);
  });

  it('follows the cursor: new events once settled, then nothing and the same cursor', async () => {
    const start = (await page(ownerKey, '?cursor=now')).meta.next_cursor;
    await levelUp();

    // Younger than the settle margin (10 s): held back, the cursor doesn't move past them.
    const early = await page(ownerKey, `?cursor=${start}`);
    expect(early.data).toEqual([]);
    expect(early.meta.next_cursor).toBe(start);

    await settleEvents(ctx);
    const next = await page(ownerKey, `?cursor=${start}`);
    expect(next.data.length).toBeGreaterThanOrEqual(2);
    expect(next.data.every((e) => e.type === 'level_up')).toBe(true);
    expect(next.data.map((e) => e.skill)).toEqual(
      expect.arrayContaining(['Hitpoints', 'Strength']),
    );
    expect(next.meta.next_cursor).not.toBe(start);

    const caughtUp = await page(ownerKey, `?cursor=${next.meta.next_cursor}`);
    expect(caughtUp.data).toEqual([]);
    expect(caughtUp.meta.next_cursor).toBe(next.meta.next_cursor);

    // The same events one per page, oldest first.
    const seen: string[] = [];
    let cursor = start;
    for (let i = 0; i < 10; i++) {
      const p = await page(ownerKey, `?cursor=${cursor}&limit=1`);
      if (p.data.length === 0) break;
      seen.push(...p.data.map((e) => e.id));
      cursor = p.meta.next_cursor;
    }
    expect(seen).toEqual(next.data.map((e) => e.id));
    expect(cursor).toBe(next.meta.next_cursor);
  });

  it('filters by type, minimum value and account', async () => {
    const types = await page(ownerKey, '?types=loot');
    expect(types.data.map((e) => e.id)).toEqual([loot]);
    const rich = await page(ownerKey, '?min_value=1');
    expect(rich.data.map((e) => e.id)).toEqual([loot]);
    const tooRich = await page(ownerKey, `?min_value=${Number.MAX_SAFE_INTEGER}`);
    expect(tooRich.data).toEqual([]);
    const alt = await page(ownerKey, `?accounts=${world.alt.id}`);
    expect(alt.data).toEqual([]);
    const main = await page(ownerKey, `?accounts=${world.main.id}&types=loot`);
    expect(main.data.map((e) => e.id)).toEqual([loot]);
  });

  it('serves guild members the events shared with them, and nothing without `events`', async () => {
    expect((await page(memberKey, '?types=loot')).data.map((e) => e.id)).toEqual([loot]);
    expect((await page(statsKey)).data).toEqual([]);
    const res = await GET(
      v1Request(ctx, `/events?accounts=${world.main.id}`, { key: statsKey.key }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('404 for an unknown account, 400 for a bad cursor, limit, value or list', async () => {
    const unknown = await GET(
      v1Request(ctx, `/events?accounts=${RANDOM_ID}`, { key: ownerKey.key }),
    );
    expect(unknown.status).toBe(404);
    for (const query of [
      '?cursor=not-a-cursor',
      `?cursor=${Buffer.from('v1:-1').toString('base64url')}`,
      '?limit=0',
      '?limit=501',
      '?limit=ten',
      '?min_value=-1',
      '?types=loot,,death',
      '?accounts=bad!id',
    ]) {
      const res = await GET(v1Request(ctx, `/events${query}`, { key: ownerKey.key }));
      expect(res.status, query).toBe(400);
      const body = (await res.json()) as { error: { code: string; details?: unknown[] } };
      expect(body.error.code, query).toBe('invalid_request');
    }
  });
});

describe('GET /api/v1/leaderboards/loot', () => {
  async function loot(key: TestKey, query = '') {
    return getLootLeaderboard(v1Request(ctx, `/leaderboards/loot${query}`, { key: key.key }));
  }

  it('ranks the period’s drops, each exactly as /events serves it', async () => {
    const res = await loot(ownerKey, '?period=week&limit=5');
    expect(res.status).toBe(200);
    const { data } = expectShape(LootLeaderboardResponse, await res.json());
    expect(data.period).toBe('week');
    expect(Date.parse(data.to) - Date.parse(data.from)).toBe(7 * 24 * 60 * 60 * 1000);
    const feed = await page(ownerKey, '?types=loot');
    expect(data.entries).toEqual(feed.data.map((event, i) => ({ rank: i + 1, event })));
    expect(data.entries[0]?.event).toMatchObject({
      type: 'loot',
      account: { id: world.main.id, name: world.main.name },
    });
    expect(data.entries[0]?.event.value_gp).toBeGreaterThan(0);

    const byDefault = expectShape(LootLeaderboardResponse, await (await loot(memberKey)).json());
    expect(byDefault.data.period).toBe('day');
  });

  it('is empty for a key without `events`', async () => {
    const res = await loot(statsKey, '?period=month');
    expect(res.status).toBe(200);
    expect(expectShape(LootLeaderboardResponse, await res.json()).data.entries).toEqual([]);
  });

  it('400 for an unknown period or a limit outside 1…50', async () => {
    for (const query of ['?period=year', '?limit=0', '?limit=51', '?limit=ten', '?limit=']) {
      const res = await loot(ownerKey, query);
      expect(res.status, query).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code, query).toBe('invalid_request');
    }
  });
});
