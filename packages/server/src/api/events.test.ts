/**
 * The /events cursor feed (D-73): order, paging, the settled prefix (DB-4), `now`, filters, access
 * and redaction.
 */
import { randomUUID } from 'node:crypto';
import { CATEGORIES } from '@hub/core';
import { events } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deathData,
  seedAccount,
  seedEvent,
  seedSharing,
  seedUser,
  superiorData,
  type SeededAccount,
  type SeededUser,
} from '../accounts/test-support';
import { createHarness, newHash, wire } from '../ingest/test-support';
import { ApiError } from './errors';
import {
  API_EVENTS_SETTLE_MS,
  EVENTS_DEFAULT_LIMIT,
  apiEvents,
  decodeEventsCursor,
  encodeEventsCursor,
  type ApiEventsParams,
  type ApiEventsPage,
} from './events';
import { makeKey, type TestKey } from './test-support';

// Real time: the settled prefix compares inserted_at with the database clock.
let t: TestDatabase;
let owner: SeededUser;
let member: SeededUser;
let guild: SeededAccount;
let second: SeededAccount;
let hidden: SeededAccount;
let ownerKey: TestKey;
let memberKey: TestKey;

const SETTLED = () => new Date(Date.now() - 10 * API_EVENTS_SETTLE_MS);

beforeAll(async () => {
  t = await createTestDatabase('api-events');
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

/** A settled event (inserted well before the margin) unless `young`, received now. */
async function event(
  account: SeededAccount,
  opts: {
    type?: string;
    valueGp?: number | null;
    data?: Record<string, unknown>;
    young?: boolean;
  } = {},
): Promise<{ id: string; seq: number }> {
  const now = new Date();
  return seedEvent(t.db, account.id, {
    type: opts.type ?? 'loot',
    occurredAt: now,
    receivedAt: now,
    valueGp: opts.valueGp ?? null,
    ...(opts.data ? { data: opts.data } : {}),
    ...(opts.young ? {} : { insertedAt: SETTLED() }),
  });
}

async function page(key: TestKey, params: ApiEventsParams = {}): Promise<ApiEventsPage> {
  return apiEvents(t.db, key.principal, params, new Date());
}

/** The cursor a consumer starting now would get. */
async function baseline(key: TestKey = memberKey): Promise<string> {
  const { events: list, nextCursor } = await page(key, { cursor: 'now' });
  expect(list).toEqual([]);
  return nextCursor;
}

async function settle(ids: string[]): Promise<void> {
  await t.db.update(events).set({ insertedAt: SETTLED() }).where(inArray(events.id, ids));
}

const ids = (p: ApiEventsPage) => p.events.map((e) => e.id);

describe('cursors', () => {
  it('round-trip as opaque base64url of "v1:<seq>"', () => {
    for (const seq of [0, 1, 42, Number.MAX_SAFE_INTEGER]) {
      const cursor = encodeEventsCursor(seq);
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(Buffer.from(cursor, 'base64url').toString()).toBe(`v1:${seq}`);
      expect(decodeEventsCursor(cursor)).toBe(seq);
    }
  });

  it.each([
    ['garbage', 'abc'],
    ['another version', Buffer.from('v2:5').toString('base64url')],
    ['a negative seq', Buffer.from('v1:-1').toString('base64url')],
    ['a leading zero', Buffer.from('v1:01').toString('base64url')],
    ['a fraction', Buffer.from('v1:1.5').toString('base64url')],
    ['an unsafe integer', Buffer.from('v1:9007199254740993').toString('base64url')],
    ['padding', `${Buffer.from('v1:5').toString('base64url')}=`],
    ['standard base64', Buffer.from('v1:62>?').toString('base64')],
    ['an empty string', ''],
    ['a very long string', 'A'.repeat(200)],
    ['a NUL', 'djE6\u0000'],
  ])('refuses %s as invalid', async (_label, cursor) => {
    expect(decodeEventsCursor(cursor)).toBeNull();
    const err = await page(memberKey, { cursor }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'invalid' });
  });
});

describe('paging', () => {
  it('serves events after the cursor in seq order, a page at a time', async () => {
    const start = await baseline();
    const seeded = [];
    for (let i = 0; i < 5; i++) seeded.push(await event(i % 2 === 0 ? guild : second));
    await event(hidden); // not the member's to read

    const first = await page(memberKey, { cursor: start, limit: 2 });
    expect(ids(first)).toEqual(seeded.slice(0, 2).map((e) => e.id));
    expect(decodeEventsCursor(first.nextCursor)).toBe(seeded[1]?.seq);
    const next = await page(memberKey, { cursor: first.nextCursor, limit: 2 });
    expect(ids(next)).toEqual(seeded.slice(2, 4).map((e) => e.id));
    const last = await page(memberKey, { cursor: next.nextCursor, limit: 2 });
    expect(ids(last)).toEqual([seeded[4]?.id]);
    // A short page ends at the settled prefix, past the event the member can't read.
    const caughtUp = await page(memberKey, { cursor: last.nextCursor, limit: 2 });
    expect(caughtUp.events).toEqual([]);
    expect(caughtUp.nextCursor).toBe(last.nextCursor);
    expect(decodeEventsCursor(last.nextCursor)).toBeGreaterThan(seeded[4]?.seq ?? 0);
  });

  it('without a cursor, returns the newest events oldest first and a cursor after them', async () => {
    const seeded = [await event(guild), await event(second), await event(guild)];
    const newest = await page(memberKey, { limit: 2 });
    expect(ids(newest)).toEqual([seeded[1]?.id, seeded[2]?.id]);
    expect(decodeEventsCursor(newest.nextCursor)).toBe(seeded[2]?.seq);
    expect((await page(memberKey, { cursor: newest.nextCursor })).events).toEqual([]);
  });

  it('with cursor=now, returns nothing and a cursor from which new events follow', async () => {
    await event(guild);
    const start = await baseline();
    const later = await event(guild);
    expect(ids(await page(memberKey, { cursor: start }))).toEqual([later.id]);
  });

  it('defaults to 100 events and refuses a limit outside 1…500', async () => {
    const start = await baseline();
    for (let i = 0; i < EVENTS_DEFAULT_LIMIT + 5; i += 1) await event(guild);
    expect((await page(memberKey, { cursor: start })).events).toHaveLength(EVENTS_DEFAULT_LIMIT);
    expect((await page(memberKey, { cursor: start, limit: 500 })).events).toHaveLength(
      EVENTS_DEFAULT_LIMIT + 5,
    );
    for (const limit of [0, 501, 1.5, -1, Number.NaN]) {
      await expect(page(memberKey, { cursor: start, limit })).rejects.toMatchObject({
        code: 'invalid',
      });
    }
  });
});

describe('the settled prefix (DB-4)', () => {
  it('never moves the cursor past a lower seq that is still uncommitted', async () => {
    const start = await baseline();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let inserted!: (row: { id: string; seq: number }) => void;
    const insertedRow = new Promise<{ id: string; seq: number }>((resolve) => (inserted = resolve));
    const slow = t.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(events)
        .values({
          pluginEventId: randomUUID(),
          accountId: guild.id,
          type: 'loot',
          occurredAt: new Date(),
          receivedAt: new Date(),
          data: { type: 'loot', data: {}, eventId: 'slow', timestamp: 0 },
        })
        .returning({ id: events.id, seq: events.seq });
      if (!row) throw new Error('no row');
      inserted(row);
      await gate;
    });
    const lower = await insertedRow;
    const higher = await event(guild, { young: true });
    expect(higher.seq).toBeGreaterThan(lower.seq);

    // The committed higher seq is young, so the prefix stops before it: nothing yet.
    const held = await page(memberKey, { cursor: start });
    expect(held.events).toEqual([]);
    expect(held.nextCursor).toBe(start);

    release();
    await slow;
    // Committed now, but inserted a moment ago: still held back.
    expect((await page(memberKey, { cursor: start })).events).toEqual([]);
    await settle([lower.id, higher.id]);
    expect(ids(await page(memberKey, { cursor: start }))).toEqual([lower.id, higher.id]);
  });

  it('stops at the first young row even when a settled one follows it', async () => {
    const start = await baseline();
    const before = await event(guild);
    const young = await event(guild, { young: true });
    const after = await event(guild);
    const first = await page(memberKey, { cursor: start });
    expect(ids(first)).toEqual([before.id]);
    expect(decodeEventsCursor(first.nextCursor)).toBe(before.seq);
    await settle([young.id]);
    expect(ids(await page(memberKey, { cursor: first.nextCursor }))).toEqual([young.id, after.id]);
  });

  it('hands out a cursor=now below young rows too', async () => {
    const settled = await event(guild);
    await event(guild, { young: true });
    const { nextCursor } = await page(memberKey, { cursor: 'now' });
    expect(decodeEventsCursor(nextCursor)).toBe(settled.seq);
    // Settle everything for the tests that follow.
    await t.db.update(events).set({ insertedAt: SETTLED() });
  });
});

describe('filters', () => {
  it('filters by type, account and minimum value, and still moves the cursor past the rest', async () => {
    const start = await baseline();
    const cheap = await event(guild, { valueGp: 10 });
    const rich = await event(guild, { valueGp: 5_000_000 });
    const level = await event(second, { type: 'level_up' });
    const richOther = await event(second, { valueGp: 9_000_000 });

    expect(ids(await page(memberKey, { cursor: start, types: ['level_up'] }))).toEqual([level.id]);
    expect(ids(await page(memberKey, { cursor: start, types: ['level_up', 'loot'] }))).toEqual([
      cheap.id,
      rich.id,
      level.id,
      richOther.id,
    ]);
    expect(ids(await page(memberKey, { cursor: start, minValue: 1_000_000 }))).toEqual([
      rich.id,
      richOther.id,
    ]);
    const onlyGuild = await page(memberKey, { cursor: start, accountIds: [guild.publicId] });
    expect(ids(onlyGuild)).toEqual([cheap.id, rich.id]);
    expect(decodeEventsCursor(onlyGuild.nextCursor)).toBe(richOther.seq);
    const both = await page(memberKey, {
      cursor: start,
      accountIds: [second.publicId, guild.publicId],
      minValue: 1_000_000,
      types: ['loot'],
    });
    expect(ids(both)).toEqual([rich.id, richOther.id]);
  });

  it('answers not_found for an account the key may not read events of, like an unknown one', async () => {
    for (const id of [hidden.publicId, 'unknown1234', 'x\u0000']) {
      const err = await page(memberKey, { accountIds: [id] }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'not_found' });
    }
    expect((await page(ownerKey, { accountIds: [hidden.publicId] })).events.length).toBeGreaterThan(
      0,
    );
  });

  it('refuses bad filters', async () => {
    for (const params of [
      { minValue: -1 },
      { minValue: 1.5 },
      { types: [''] },
      { types: ['x'.repeat(65)] },
      { types: Array.from({ length: 65 }, (_, i) => `t${i}`) },
      { accountIds: Array.from({ length: 101 }, (_, i) => `a${i}`) },
    ]) {
      await expect(page(memberKey, params)).rejects.toMatchObject({ code: 'invalid' });
    }
  });
});

describe('access and redaction', () => {
  it('serves only accounts whose events the key may read, and follows sharing at once', async () => {
    const start = await baseline(ownerKey);
    const secret = await event(hidden);
    const open = await event(guild);
    expect(ids(await page(memberKey, { cursor: start }))).toEqual([open.id]);
    expect(ids(await page(ownerKey, { cursor: start }))).toEqual([secret.id, open.id]);
    const statsOnly = await makeKey(t.db, owner.id, { categories: ['stats'] });
    expect((await page(statsOnly, { cursor: start })).events).toEqual([]);
    await seedSharing(t.db, second.id, 'events', 'private');
    const later = await event(second);
    expect((await page(memberKey, { cursor: start })).events.map((e) => e.id)).not.toContain(
      later.id,
    );
  });

  it('strips death and superior locations without a location category', async () => {
    const start = await baseline(ownerKey);
    const death = await event(guild, { type: 'death', data: deathData() });
    const superior = await event(guild, { type: 'superior_spawn', data: superiorData() });
    const location = (p: ApiEventsPage) =>
      p.events.map((e) => (e.data as { data: Record<string, unknown> }).data.location ?? null);

    // The owner's full key keeps them; the member and an events-only key of the owner don't.
    expect(location(await page(ownerKey, { cursor: start }))).toEqual([
      { x: 3068, y: 3858, plane: 0 },
      { x: 1698, y: 10082, plane: 0 },
    ]);
    const eventsOnly = await makeKey(t.db, owner.id, { categories: ['events'] });
    for (const key of [memberKey, eventsOnly]) {
      const p = await page(key, { cursor: start });
      expect(ids(p)).toEqual([death.id, superior.id]);
      expect(location(p)).toEqual([null, null]);
      expect(JSON.stringify(p)).not.toMatch(/3858|10082/);
    }
    const withHistory = await makeKey(t.db, owner.id, {
      categories: ['events', 'location_history'],
    });
    expect(location(await page(withHistory, { cursor: start }))[0]).toEqual({
      x: 3068,
      y: 3858,
      plane: 0,
    });
  });

  it('returns the public event shape: no seq, no UI icon', async () => {
    const start = await baseline();
    const e = await event(guild, { valueGp: 38_200_000 });
    const [got] = (await page(memberKey, { cursor: start })).events;
    const [row] = await t.db.select().from(events).where(eq(events.id, e.id));
    expect(got).toEqual({
      id: e.id,
      type: 'loot',
      account: { id: guild.publicId, name: 'Guild Gary' },
      occurredAt: row?.occurredAt.toISOString(),
      receivedAt: row?.receivedAt.toISOString(),
      valueGp: 38_200_000,
      itemId: null,
      npcId: null,
      skill: null,
      level: null,
      tier: null,
      points: null,
      specialWorld: false,
      data: row?.data,
      title: expect.any(String) as unknown,
      line: expect.any(String) as unknown,
    });
  });
});

describe('events ingested from the fixtures', () => {
  it('serves them redacted for a member, complete for the owner', async () => {
    const h = createHarness(t);
    const ownerId = await h.seedUser();
    const device = await h.seedDevice(ownerId);
    const reader = await h.seedUser();
    const ownerFull = await makeKey(t.db, ownerId);
    const readerKey = await makeKey(t.db, reader, { categories: [...CATEGORIES] });
    const start = await baseline(ownerFull);
    const body = wire('event-death-dangerous', { hash: newHash(), freshEventIds: true });
    expect((await h.send(device, body)).status).toBe(200);
    await t.db.update(events).set({ insertedAt: SETTLED() });

    const mine = await page(ownerFull, { cursor: start });
    expect(mine.events.map((e) => [e.type, e.valueGp])).toEqual([['death', 34_906]]);
    expect(JSON.stringify(mine)).toMatch(/3858/);
    const theirs = await page(readerKey, { cursor: start });
    expect(theirs.events.map((e) => e.account.name)).toEqual(['Iron Mira']);
    expect(JSON.stringify(theirs)).not.toMatch(/3858|3068/);
    expect(theirs.events[0]?.line).toContain('Iron Mira');
  });
});
