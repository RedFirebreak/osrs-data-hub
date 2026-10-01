/**
 * /events with `from`/`to` (D-98): the range bounds, newest-first paging without gaps or repeats
 * (also across equal `occurred_at`, several accounts and events arriving mid-walk), the filters,
 * access, redaction, and the two cursor kinds kept apart. Every test has its own day.
 */
import { DAY_MS } from '@hub/core';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deathData,
  seedAccount,
  seedEvent,
  seedSharing,
  seedUser,
  type SeededAccount,
  type SeededUser,
} from '../accounts/test-support';
import {
  API_EVENTS_SETTLE_MS,
  EVENTS_DEFAULT_LIMIT,
  apiEvents,
  apiEventsInRange,
  decodeEventsCursor,
  decodeEventsRangeCursor,
  encodeEventsCursor,
  encodeEventsRangeCursor,
  type ApiEventsRangePage,
  type ApiEventsRangeParams,
} from './events';
import { makeKey, type TestKey } from './test-support';

let t: TestDatabase;
let owner: SeededUser;
let member: SeededUser;
let guild: SeededAccount;
let second: SeededAccount;
let hidden: SeededAccount;
let ownerKey: TestKey;
let memberKey: TestKey;

beforeAll(async () => {
  t = await createTestDatabase('api-events-range');
  owner = await seedUser(t.db, { name: 'Owner' });
  member = await seedUser(t.db, { name: 'Member' });
  guild = await seedAccount(t.db, { name: 'Guild Gary', owner: owner.id });
  second = await seedAccount(t.db, { name: 'Second Sue', owner: owner.id });
  hidden = await seedAccount(t.db, { name: 'Private Pete', owner: owner.id });
  await seedSharing(t.db, hidden.id, 'events', 'private');
  ownerKey = await makeKey(t.db, owner.id);
  memberKey = await makeKey(t.db, member.id);
});

afterAll(async () => {
  await t.drop();
});

const at = (iso: string) => new Date(iso);

/** The whole of one UTC day, so a test only sees the events it seeded on it. */
function day(date: string): { from: Date; to: Date } {
  const from = at(`${date}T00:00:00.000Z`);
  return { from, to: new Date(from.getTime() + DAY_MS - 1) };
}

async function event(
  account: SeededAccount,
  occurredAt: Date,
  opts: { type?: string; valueGp?: number | null; data?: Record<string, unknown> } = {},
): Promise<string> {
  const { id } = await seedEvent(t.db, account.id, {
    type: opts.type ?? 'loot',
    occurredAt,
    valueGp: opts.valueGp ?? null,
    ...(opts.data ? { data: opts.data } : {}),
  });
  return id;
}

async function page(key: TestKey, params: ApiEventsRangeParams): Promise<ApiEventsRangePage> {
  return apiEventsInRange(t.db, key.principal, params);
}

const ids = (p: ApiEventsRangePage) => p.events.map((e) => e.id);

/** Every page of the range, following `nextCursor` until it is null. */
async function walk(key: TestKey, params: ApiEventsRangeParams): Promise<string[][]> {
  const pages: string[][] = [];
  let cursor: string | null | undefined;
  while (cursor !== null) {
    expect(pages.length).toBeLessThan(50);
    const p: ApiEventsRangePage = await page(key, { ...params, ...(cursor ? { cursor } : {}) });
    pages.push(ids(p));
    cursor = p.nextCursor;
  }
  return pages;
}

describe('the range', () => {
  it('includes both bounds and nothing outside them, newest first', async () => {
    const from = at('2026-09-01T10:00:00.000Z');
    const to = at('2026-09-01T11:00:00.000Z');
    await event(guild, at('2026-09-01T09:59:59.999Z'));
    const first = await event(guild, from);
    const middle = await event(second, at('2026-09-01T10:30:00.000Z'));
    const last = await event(guild, to);
    await event(guild, at('2026-09-01T11:00:00.001Z'));

    const p = await page(memberKey, { from, to });
    expect(ids(p)).toEqual([last, middle, first]);
    expect(p.nextCursor).toBeNull();
  });

  it('defaults to the 30 days up to now, or up to `to`', async () => {
    const now = at('2026-08-15T00:00:00.000Z');
    await event(guild, new Date(now.getTime() - 31 * DAY_MS));
    const old = await event(guild, new Date(now.getTime() - 29 * DAY_MS));
    const newest = await event(guild, now);
    await event(guild, new Date(now.getTime() + 1));

    const from = new Date(now.getTime() - 30 * DAY_MS);
    const withFrom = await apiEventsInRange(t.db, memberKey.principal, { from }, now);
    expect(ids(withFrom)).toEqual([newest, old]);
    const withTo = await page(memberKey, { to: now });
    expect(ids(withTo)).toEqual([newest, old]);
  });

  it('refuses a `from` after `to` and dates that are none', async () => {
    for (const params of [
      { from: at('2026-09-02T00:00:00Z'), to: at('2026-09-01T00:00:00Z') },
      { from: new Date(Number.NaN) },
      { to: new Date(Number.NaN) },
    ]) {
      await expect(page(memberKey, params)).rejects.toMatchObject({ code: 'invalid' });
    }
  });

  it('serves events younger than the feed’s settle margin', async () => {
    // Received and stored just now, as ingest would: the feed holds it back for its margin.
    const now = new Date();
    const { id: young } = await seedEvent(t.db, guild.id, { type: 'loot', occurredAt: now });
    expect(ids(await page(memberKey, { from: now, to: now }))).toEqual([young]);
    const feed = await apiEvents(t.db, memberKey.principal, { limit: 500 });
    expect(feed.events.map((e) => e.id)).not.toContain(young);
  });
});

describe('paging', () => {
  it('visits every event once across equal timestamps and accounts', async () => {
    const range = day('2026-09-02');
    const noon = at('2026-09-02T12:00:00.000Z');
    const early = await event(guild, at('2026-09-02T11:00:00.000Z'));
    const tied: string[] = [];
    for (let i = 0; i < 5; i++) tied.push(await event(i % 2 === 0 ? guild : second, noon));
    const late = await event(second, at('2026-09-02T13:00:00.000Z'));
    await event(hidden, noon); // not the member's to read
    // Newest first; events of the same instant by descending seq, the later stored first.
    const expected = [late, ...tied.toReversed(), early];

    for (const limit of [1, 2, 3, 6]) {
      const pages = await walk(memberKey, { ...range, limit });
      expect(pages.flat(), `limit ${limit}`).toEqual(expected);
      expect(pages.slice(0, -1).every((p) => p.length === limit)).toBe(true);
    }
    // A last page that is exactly full still ends the walk: no empty page after it.
    expect(await walk(memberKey, { ...range, limit: 7 })).toEqual([expected]);
  });

  it('is not shifted by events that arrive during the walk', async () => {
    const range = day('2026-09-03');
    const hour = (h: number) => at(`2026-09-03T${String(h).padStart(2, '0')}:00:00.000Z`);
    const seeded = [];
    for (const h of [10, 11, 12, 13]) seeded.push(await event(guild, hour(h)));
    const first = await page(memberKey, { ...range, limit: 2 });
    expect(ids(first)).toEqual([seeded[3], seeded[2]]);
    if (first.nextCursor === null) throw new Error('expected a second page');

    // Newer than the cursor, and of the cursor's own instant but stored after it: both sort
    // before the cursor, so the walk goes on where it was.
    await event(second, hour(14));
    await event(second, hour(12));
    const rest = await walk(memberKey, { ...range, limit: 2, cursor: first.nextCursor });
    expect(rest).toEqual([[seeded[1], seeded[0]]]);
  });

  it('defaults to 100 events and refuses a limit outside 1…500', async () => {
    const range = day('2026-09-04');
    for (let i = 0; i < EVENTS_DEFAULT_LIMIT + 5; i += 1) {
      await event(guild, new Date(range.from.getTime() + i));
    }
    const first = await page(memberKey, range);
    expect(first.events).toHaveLength(EVENTS_DEFAULT_LIMIT);
    expect(first.nextCursor).not.toBeNull();
    expect((await page(memberKey, { ...range, limit: 500 })).events).toHaveLength(
      EVENTS_DEFAULT_LIMIT + 5,
    );
    for (const limit of [0, 501, 1.5, -1, Number.NaN]) {
      await expect(page(memberKey, { ...range, limit })).rejects.toMatchObject({ code: 'invalid' });
    }
  });
});

describe('cursors', () => {
  it('round-trip as opaque base64url of "r1:<ms>:<seq>"', () => {
    const occurredAt = at('2026-09-05T12:00:00.123Z');
    for (const seq of [1, 42, Number.MAX_SAFE_INTEGER]) {
      const cursor = encodeEventsRangeCursor(occurredAt, seq);
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(Buffer.from(cursor, 'base64url').toString()).toBe(`r1:${occurredAt.getTime()}:${seq}`);
      expect(decodeEventsRangeCursor(cursor)).toEqual({ occurredAt, seq });
    }
  });

  it.each([
    ['garbage', 'abc'],
    ['a feed cursor', encodeEventsCursor(5)],
    ['now', 'now'],
    ['another version', Buffer.from('r2:1:5').toString('base64url')],
    ['a missing seq', Buffer.from('r1:1790000000000').toString('base64url')],
    ['a negative seq', Buffer.from('r1:1790000000000:-1').toString('base64url')],
    ['a leading zero', Buffer.from('r1:01:5').toString('base64url')],
    ['a time beyond what a date holds', Buffer.from('r1:9007199254740991:5').toString('base64url')],
    ['padding', `${Buffer.from('r1:1:5').toString('base64url')}=`],
    ['an empty string', ''],
    ['a very long string', 'A'.repeat(200)],
  ])('refuses %s as invalid', async (_label, cursor) => {
    expect(decodeEventsRangeCursor(cursor)).toBeNull();
    await expect(page(memberKey, { ...day('2026-09-05'), cursor })).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('are refused by the feed, which has its own', async () => {
    const cursor = encodeEventsRangeCursor(at('2026-09-05T12:00:00.000Z'), 5);
    expect(decodeEventsCursor(cursor)).toBeNull();
    await expect(apiEvents(t.db, memberKey.principal, { cursor })).rejects.toMatchObject({
      code: 'invalid',
    });
  });
});

describe('filters', () => {
  it('filters by type, account and minimum value, also across pages', async () => {
    const range = day('2026-09-06');
    const minute = (m: number) => new Date(range.from.getTime() + m * 60_000);
    const cheap = await event(guild, minute(1), { valueGp: 10 });
    const rich = await event(guild, minute(2), { valueGp: 5_000_000 });
    const level = await event(second, minute(3), { type: 'level_up' });
    const richOther = await event(second, minute(4), { valueGp: 9_000_000 });

    expect(ids(await page(memberKey, { ...range, types: ['level_up'] }))).toEqual([level]);
    expect(ids(await page(memberKey, { ...range, types: ['level_up', 'loot'] }))).toEqual([
      richOther,
      level,
      rich,
      cheap,
    ]);
    expect(await walk(memberKey, { ...range, minValue: 1_000_000, limit: 1 })).toEqual([
      [richOther],
      [rich],
    ]);
    expect(await walk(memberKey, { ...range, accountIds: [guild.publicId], limit: 1 })).toEqual([
      [rich],
      [cheap],
    ]);
    const both = await page(memberKey, {
      ...range,
      accountIds: [second.publicId, guild.publicId],
      minValue: 1_000_000,
      types: ['loot'],
    });
    expect(ids(both)).toEqual([richOther, rich]);
  });

  it('refuses bad filters', async () => {
    const range = day('2026-09-06');
    for (const params of [
      { minValue: -1 },
      { minValue: 1.5 },
      { types: [''] },
      { types: ['x'.repeat(65)] },
      { types: Array.from({ length: 65 }, (_, i) => `t${i}`) },
      { accountIds: Array.from({ length: 101 }, (_, i) => `a${i}`) },
    ]) {
      await expect(page(memberKey, { ...range, ...params })).rejects.toMatchObject({
        code: 'invalid',
      });
    }
  });
});

describe('access and redaction', () => {
  it('answers not_found for an account the key may not read events of, like an unknown one', async () => {
    const range = day('2026-09-07');
    const secret = await event(hidden, range.from);
    for (const id of [hidden.publicId, 'unknown1234', 'x\u0000']) {
      await expect(page(memberKey, { ...range, accountIds: [id] })).rejects.toMatchObject({
        code: 'not_found',
      });
    }
    expect(ids(await page(ownerKey, { ...range, accountIds: [hidden.publicId] }))).toEqual([
      secret,
    ]);
  });

  it('serves only accounts whose events the key may read', async () => {
    const range = day('2026-09-08');
    const open = await event(guild, range.from);
    const secret = await event(hidden, range.to);
    expect(ids(await page(memberKey, range))).toEqual([open]);
    expect(ids(await page(ownerKey, range))).toEqual([secret, open]);
    const statsOnly = await makeKey(t.db, owner.id, { categories: ['stats'] });
    expect(await page(statsOnly, range)).toEqual({ events: [], nextCursor: null });
  });

  it('serves each event exactly as the feed does, location redacted alike', async () => {
    // The member would have both location categories, guild by default (D-96).
    for (const c of ['location_live', 'location_history'] as const)
      await seedSharing(t.db, second.id, c, 'private');
    const range = day('2026-09-10');
    const { id } = await seedEvent(t.db, second.id, {
      type: 'death',
      occurredAt: range.from,
      data: deathData(),
      insertedAt: new Date(Date.now() - 10 * API_EVENTS_SETTLE_MS),
    });

    for (const key of [ownerKey, memberKey]) {
      const [ranged] = (await page(key, range)).events;
      const feed = await apiEvents(t.db, key.principal, { accountIds: [second.publicId] });
      expect(ranged?.id).toBe(id);
      expect(ranged).toEqual(feed.events.find((e) => e.id === id));
    }
    const location = (p: ApiEventsRangePage) =>
      (p.events[0]?.data as { data: Record<string, unknown> }).data.location ?? null;
    expect(location(await page(ownerKey, range))).toEqual({ x: 3068, y: 3858, plane: 0 });
    expect(location(await page(memberKey, range))).toBeNull();
    expect(JSON.stringify(await page(memberKey, range))).not.toMatch(/3858/);
  });
});
