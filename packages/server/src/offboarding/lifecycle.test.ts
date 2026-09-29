/**
 * Offboarding end to end with real plugin payloads (packages/fixtures) through the real ingest
 * handler: what a departed player's plugin sees, and what a hard delete leaves behind.
 */
import {
  accountLinks,
  accountNames,
  deviceAccounts,
  equipmentChanges,
  events,
  latestState,
  locationSamples,
  osrsAccounts,
  playSessions,
  rawPayloads,
  wealthDaily,
  xpSamples,
} from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { FIXTURES } from '@hub/fixtures';
import { eq, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createHarness,
  newHash,
  wire,
  type Harness,
  type SeededDevice,
} from '../ingest/test-support';
import { expireGracePeriods } from './expire';
import { offboardUser, restoreUser } from './offboard';
import { refreshXpAggregates } from './test-support';

let t: TestDatabase;
let h: Harness;

beforeAll(async () => {
  t = await createTestDatabase('offboard_lifecycle');
  h = createHarness(t);
});

afterAll(async () => {
  await t.drop();
});

const DAY = 86_400_000;
const UNAUTHORIZED = { status: 401, body: { ok: false, error: 'unauthorized' } };

async function rowsFor(table: PgTable, column: SQL, accountId: number): Promise<number> {
  const res = await t.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = ${accountId}`,
  );
  return res.rows[0]?.n ?? -1;
}

/** Rows about the account in every table ingest writes, plus both XP aggregates. */
async function footprint(accountId: number): Promise<Record<string, number>> {
  const tables: [string, PgTable, SQL][] = [
    ['osrs_accounts', osrsAccounts, sql`id`],
    ['account_names', accountNames, sql`account_id`],
    ['account_links', accountLinks, sql`account_id`],
    ['device_accounts', deviceAccounts, sql`account_id`],
    ['latest_state', latestState, sql`account_id`],
    ['xp_samples', xpSamples, sql`account_id`],
    ['location_samples', locationSamples, sql`account_id`],
    ['equipment_changes', equipmentChanges, sql`account_id`],
    ['wealth_daily', wealthDaily, sql`account_id`],
    ['events', events, sql`account_id`],
    ['play_sessions', playSessions, sql`account_id`],
  ];
  const out: Record<string, number> = {};
  for (const [name, table, column] of tables) out[name] = await rowsFor(table, column, accountId);
  for (const view of ['xp_hourly', 'xp_daily']) {
    const res = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(view)} WHERE account_id = ${accountId}`,
    );
    out[view] = res.rows[0]?.n ?? -1;
  }
  return out;
}

/** Sends a snapshot and a loot event for a fresh account; returns its id. */
async function play(device: SeededDevice, hash: string): Promise<number> {
  expect(await h.send(device, wire('snapshot-normal', { hash }))).toMatchObject({ status: 200 });
  const loot = wire('event-loot', { hash, freshEventIds: true });
  expect(await h.send(device, loot)).toMatchObject({ status: 200 });
  const id = await h.accountIdByHash(hash);
  if (id === undefined) throw new Error('account not created');
  return id;
}

describe('a departed player, from offboarding to hard delete', () => {
  let device: SeededDevice;
  let accountId: number;
  let offboardedAt: Date;

  beforeAll(async () => {
    const userId = await h.seedUser();
    device = await h.seedDevice(userId);
    const hash = newHash();
    accountId = await play(device, hash);
    // Every other plugin payload too, as this character, in order: whatever it stored must go.
    let at = h.clock.now;
    for (const name of FIXTURES) {
      if (name === 'pair-request') continue;
      const body = wire(name, { hash, freshEventIds: true });
      at += 60_000;
      body.timestamp = at - 1_000;
      expect(await h.send(device, body, { at }), name).toMatchObject({ status: 200 });
    }
    await refreshXpAggregates(t.db);
    offboardedAt = new Date(h.clock.now);
  });

  it('stored the account in every table the payloads touch', async () => {
    const before = await footprint(accountId);
    for (const [table, n] of Object.entries(before)) expect(n, table).toBeGreaterThan(0);
    // One of each event type the fixtures carry (loot, death, level-ups, diaries, …).
    const types = await t.db
      .selectDistinct({ type: events.type })
      .from(events)
      .where(eq(events.accountId, accountId));
    expect(types.length).toBeGreaterThanOrEqual(9);
  });

  it('answers 401 once the user is offboarded: the plugin disables the connection', async () => {
    const result = await offboardUser(t.db, {
      userId: device.userId,
      reason: 'left_guild',
      graceDays: 30,
      now: offboardedAt,
    });
    expect(result).toMatchObject({ hidden: [accountId], revokedDevices: 1 });

    const again = wire('event-loot', { hash: newHash(), freshEventIds: true });
    expect(await h.send(device, again)).toEqual(UNAUTHORIZED);
  });

  it('keeps answering 401 after a return within the grace period (devices stay revoked)', async () => {
    await restoreUser(t.db, { userId: device.userId, actorLabel: 'login' });
    const [account] = await t.db
      .select({ status: osrsAccounts.status })
      .from(osrsAccounts)
      .where(eq(osrsAccounts.id, accountId));
    expect(account?.status).toBe('active');
    expect(await h.send(device, wire('snapshot-normal'))).toEqual(UNAUTHORIZED);
  });

  it('hard-deletes every row of the account when the grace period ends', async () => {
    await offboardUser(t.db, {
      userId: device.userId,
      reason: 'admin',
      graceDays: 30,
      now: offboardedAt,
    });
    const result = await expireGracePeriods(t.db, {
      now: new Date(offboardedAt.getTime() + 30 * DAY),
    });

    expect(result).toEqual({ deletedUsers: 1, deletedAccounts: 1 });
    const after = await footprint(accountId);
    for (const [table, n] of Object.entries(after)) expect(n, table).toBe(0);
    // raw_payloads has no FK: its retention policy removes the bodies (D-40).
    const raw = await t.db
      .select({ id: rawPayloads.id })
      .from(rawPayloads)
      .where(eq(rawPayloads.accountId, accountId));
    expect(raw.length).toBeGreaterThan(0);
  });
});

describe('an account reported by two players', () => {
  it('passes to the player who stays and keeps its full history', async () => {
    const leaver = await h.seedDevice(await h.seedUser());
    const stayer = await h.seedDevice(await h.seedUser());
    const hash = newHash();
    const accountId = await play(leaver, hash);
    // The same character, later reported from the other player's device.
    const later = wire('snapshot-normal', { hash });
    later.timestamp = h.clock.now + 60_000;
    expect(await h.send(stayer, later)).toMatchObject({ status: 200 });
    await refreshXpAggregates(t.db);
    const before = await footprint(accountId);

    const now = new Date(h.clock.now);
    const result = await offboardUser(t.db, {
      userId: leaver.userId,
      reason: 'lost_role',
      graceDays: 30,
      now,
    });
    expect(result).toMatchObject({ transferred: [accountId], hidden: [] });
    await expireGracePeriods(t.db, { now: new Date(now.getTime() + 31 * DAY) });

    const [account] = await t.db
      .select({ owner: osrsAccounts.ownerUserId, status: osrsAccounts.status })
      .from(osrsAccounts)
      .where(eq(osrsAccounts.id, accountId));
    expect(account).toEqual({ owner: stayer.userId, status: 'active' });
    // Only the departed player's link and device bookkeeping go.
    expect(await footprint(accountId)).toEqual({
      ...before,
      account_links: 1,
      device_accounts: 1,
    });
    // The stayer's plugin keeps working.
    const next = wire('snapshot-normal', { hash });
    next.timestamp = h.clock.now + 60_000;
    expect(await h.send(stayer, next)).toMatchObject({ status: 200 });
  });
});
