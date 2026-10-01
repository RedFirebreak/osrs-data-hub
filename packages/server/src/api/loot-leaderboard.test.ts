/**
 * GET /leaderboards/loot (D-94): the most valuable loot and PK loot of a period over the accounts
 * whose `events` the key may read, ranked by value; the period cutoff (the gains leaderboards'
 * starts, local midnight for `day`), the limit, the types and special worlds left out, access, and
 * events identical to /events (redaction included).
 */
import { events } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  seedAccount,
  seedEvent,
  seedSharing,
  seedUser,
  type SeededAccount,
  type SeededUser,
} from '../accounts/test-support';
import { updateUserSettings } from '../settings/user-settings';
import { ApiError } from './errors';
import { API_EVENTS_SETTLE_MS, apiEvents } from './events';
import {
  LOOT_LEADERBOARD_DEFAULT_LIMIT,
  LOOT_LEADERBOARD_MAX_LIMIT,
  apiLootLeaderboard,
  type ApiLootLeaderboard,
} from './leaderboards';
import { makeKey, type TestKey } from './test-support';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = new Date('2026-09-28T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase('api-loot-leaderboard');
});

afterAll(async () => {
  await t.drop();
});

interface World {
  owner: SeededUser;
  member: SeededUser;
  gary: SeededAccount;
  sue: SeededAccount;
  /** Keeps its events private: only the owner's keys read them. */
  pete: SeededAccount;
  ownerKey: TestKey;
  memberKey: TestKey;
}

/**
 * Fresh users, accounts and keys per test. Every member reads every guild account's events, so the
 * events of earlier tests are removed: each test sees only the events it seeds.
 */
async function world(): Promise<World> {
  await t.db.delete(events);
  const owner = await seedUser(t.db, { name: 'Owner' });
  const member = await seedUser(t.db, { name: 'Member' });
  const gary = await seedAccount(t.db, { name: 'Guild Gary', owner: owner.id });
  const sue = await seedAccount(t.db, { name: 'Second Sue', owner: owner.id });
  const pete = await seedAccount(t.db, { name: 'Private Pete', owner: owner.id });
  await seedSharing(t.db, pete.id, 'events', 'private');
  return {
    owner,
    member,
    gary,
    sue,
    pete,
    ownerKey: await makeKey(t.db, owner.id, { name: 'owner' }, NOW),
    memberKey: await makeKey(t.db, member.id, { name: 'member' }, NOW),
  };
}

/** A drop (loot unless `type` says otherwise) that occurred `at`. */
async function drop(
  account: SeededAccount,
  valueGp: number | null,
  opts: { at?: Date; type?: string; specialWorld?: boolean; data?: Record<string, unknown> } = {},
): Promise<string> {
  const at = opts.at ?? ago(HOUR);
  const { id } = await seedEvent(t.db, account.id, {
    type: opts.type ?? 'loot',
    occurredAt: at,
    receivedAt: at,
    valueGp,
    specialWorld: opts.specialWorld ?? false,
    ...(opts.data ? { data: opts.data } : {}),
  });
  return id;
}

function board(
  key: TestKey,
  params: Parameters<typeof apiLootLeaderboard>[2] = {},
): Promise<ApiLootLeaderboard> {
  return apiLootLeaderboard(t.db, key.principal, params, NOW);
}

const ids = (b: ApiLootLeaderboard) => b.entries.map((e) => e.event.id);

describe('apiLootLeaderboard', () => {
  it('ranks the period’s drops by value, newest first on a tie', async () => {
    const w = await world();
    const small = await drop(w.gary, 1_000);
    const big = await drop(w.sue, 38_200_000, { type: 'pk_loot' });
    const tieOld = await drop(w.gary, 5_000_000, { at: ago(3 * HOUR) });
    const tieNew = await drop(w.sue, 5_000_000, { at: ago(2 * HOUR) });

    const b = await board(w.memberKey);
    expect(b.period).toBe('day');
    expect(b.from).toBe('2026-09-28T00:00:00.000Z');
    expect(b.to).toBe(NOW.toISOString());
    expect(ids(b)).toEqual([big, tieNew, tieOld, small]);
    expect(b.entries.map((e) => e.rank)).toEqual([1, 2, 3, 4]);
    expect(b.entries[0]?.event).toMatchObject({
      type: 'pk_loot',
      account: { id: w.sue.publicId, name: 'Second Sue' },
      valueGp: 38_200_000,
      specialWorld: false,
    });
  });

  it('cuts at the period start: local midnight for `day`, the last 7 and 30 days otherwise', async () => {
    const w = await world();
    const today = await drop(w.gary, 100, { at: ago(HOUR) });
    const earlyToday = await drop(w.gary, 200, { at: ago(11 * HOUR) });
    const yesterday = await drop(w.gary, 300, { at: ago(13 * HOUR) });
    const lastWeek = await drop(w.gary, 400, { at: ago(6 * DAY) });
    const lastMonth = await drop(w.gary, 500, { at: ago(29 * DAY) });
    await drop(w.gary, 600, { at: ago(31 * DAY) });
    await drop(w.gary, 700, { at: new Date(NOW.getTime() + MIN) }); // after `now`

    expect(ids(await board(w.memberKey, { period: 'day' }))).toEqual([earlyToday, today]);
    expect(ids(await board(w.memberKey, { period: 'week' }))).toEqual([
      lastWeek,
      yesterday,
      earlyToday,
      today,
    ]);
    const month = await board(w.memberKey, { period: 'month' });
    expect(ids(month)).toEqual([lastMonth, lastWeek, yesterday, earlyToday, today]);
    expect(month.from).toBe(ago(30 * DAY).toISOString());

    // The key creator's time zone: 12:00Z is 02:00 the next day in Kiribati (UTC+14).
    await updateUserSettings(t.db, w.member.id, { timezone: 'Pacific/Kiritimati' });
    const local = await board(w.memberKey, { period: 'day' });
    expect(local.from).toBe('2026-09-28T10:00:00.000Z');
    expect(ids(local)).toEqual([today]);
  });

  it('ranks only loot and PK loot with a value, never on a special world', async () => {
    const w = await world();
    const loot = await drop(w.gary, 10);
    const pk = await drop(w.gary, 20, { type: 'pk_loot' });
    await drop(w.gary, 1_000_000, { type: 'death' });
    await drop(w.gary, 1_000_000, { type: 'collection_log' });
    await drop(w.gary, 1_000_000, { type: 'level_up' });
    await drop(w.gary, null);
    await drop(w.gary, 99_000_000, { specialWorld: true });
    expect(ids(await board(w.memberKey))).toEqual([pk, loot]);
  });

  it('returns 10 by default, up to 50, and refuses a bad limit or period', async () => {
    const w = await world();
    for (let i = 0; i < LOOT_LEADERBOARD_MAX_LIMIT + 2; i++) await drop(w.gary, 1_000 + i);
    const top = await board(w.memberKey);
    expect(top.entries).toHaveLength(LOOT_LEADERBOARD_DEFAULT_LIMIT);
    expect(top.entries[0]?.event.valueGp).toBe(1_000 + LOOT_LEADERBOARD_MAX_LIMIT + 1);
    expect((await board(w.memberKey, { limit: 1 })).entries).toHaveLength(1);
    expect((await board(w.memberKey, { limit: 50 })).entries).toHaveLength(50);
    for (const limit of [0, 51, 1.5, -1, Number.NaN]) {
      const err = await board(w.memberKey, { limit }).catch((e: unknown) => e);
      expect(err, String(limit)).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ code: 'invalid' });
    }
    await expect(board(w.memberKey, { period: 'year' as never })).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('ranks only accounts whose events the key may read', async () => {
    const w = await world();
    const gary = await drop(w.gary, 1_000);
    const sue = await drop(w.sue, 2_000);
    const pete = await drop(w.pete, 3_000);

    expect(ids(await board(w.ownerKey))).toEqual([pete, sue, gary]);
    // Pete keeps his events private.
    expect(ids(await board(w.memberKey))).toEqual([sue, gary]);
    // A key scoped to one account, and keys without `events`: that account, or nothing.
    const garyOnly = await makeKey(
      t.db,
      w.owner.id,
      { accountScope: 'list', accountPublicIds: [w.gary.publicId] },
      NOW,
    );
    expect(ids(await board(garyOnly))).toEqual([gary]);
    const statsOnly = await makeKey(t.db, w.owner.id, { categories: ['stats'] }, NOW);
    const none = await board(statsOnly);
    expect(none.entries).toEqual([]);
    expect(none.from).toBe('2026-09-28T00:00:00.000Z');
    // Sharing changes apply at once.
    await seedSharing(t.db, w.sue.id, 'events', 'private');
    expect(ids(await board(w.memberKey))).toEqual([gary]);
  });

  it('serves each event exactly as /events does, location redaction included', async () => {
    const w = await world();
    // The member would have both location categories, guild by default (D-96).
    for (const c of ['location_live', 'location_history'] as const)
      await seedSharing(t.db, w.gary.id, c, 'private');
    const data = {
      type: 'loot',
      eventId: 'loc',
      timestamp: 0,
      data: { totalValue: 5_000, location: { x: 3068, y: 3858, plane: 0 } },
    };
    const id = await drop(w.gary, 5_000, { data });
    await t.db
      .update(events)
      .set({ insertedAt: new Date(Date.now() - 10 * API_EVENTS_SETTLE_MS) })
      .where(inArray(events.id, [id]));
    const eventsOnly = await makeKey(t.db, w.owner.id, { categories: ['events'] }, NOW);

    for (const key of [w.ownerKey, w.memberKey, eventsOnly]) {
      const [entry] = (await board(key, { limit: 1 })).entries;
      const feed = await apiEvents(t.db, key.principal, { accountIds: [w.gary.publicId] });
      expect(entry?.event).toEqual(feed.events.find((e) => e.id === id));
    }
    const location = async (key: TestKey) =>
      ((await board(key)).entries[0]?.event.data as { data: Record<string, unknown> }).data
        .location ?? null;
    expect(await location(w.ownerKey)).toEqual({ x: 3068, y: 3858, plane: 0 });
    expect(await location(w.memberKey)).toBeNull();
    expect(await location(eventsOnly)).toBeNull();
    expect(JSON.stringify(await board(w.memberKey))).not.toMatch(/3858/);
  });
});
