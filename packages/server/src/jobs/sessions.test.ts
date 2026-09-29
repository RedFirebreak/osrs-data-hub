import { presenceTimeoutSeconds } from '@hub/core';
import { latestState, playSessions } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, newHash, wire, type Harness } from '../ingest/test-support';
import { seedAccount } from '../offboarding/test-support';
import { closeStaleSessions, presenceTimeoutSql } from './sessions';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase('stalesessions');
});

afterAll(async () => {
  await t.drop();
});

const NOW = new Date('2026-09-28T12:00:00Z');
const S = 1000;

describe('presenceTimeoutSql', () => {
  it('agrees with presenceTimeoutSeconds', async () => {
    const samples = [
      null,
      0,
      -1,
      -600,
      1,
      10,
      32,
      33,
      34,
      50,
      99,
      100,
      150,
      250,
      333,
      600,
      601,
      1000,
      1001,
      2500,
      5000,
      99_999,
      2_147_483_647,
    ];
    const values = sql.join(
      samples.map((v, i) => sql`(${i}::int, ${v}::int)`),
      sql`, `,
    );
    const res = await t.db.execute<{ i: number; timeout: number }>(
      sql`SELECT v.i, ${presenceTimeoutSql(sql`v.td`)} AS timeout FROM (VALUES ${values}) AS v(i, td) ORDER BY v.i`,
    );
    expect(res.rows.map((r) => r.timeout)).toEqual(samples.map((v) => presenceTimeoutSeconds(v)));
  });
});

describe('closeStaleSessions', () => {
  async function account(opts: { lastSeenAgoS: number | null; tickDelay?: number | null }) {
    const a = await seedAccount(t.db);
    if (opts.lastSeenAgoS !== null) {
      await t.db.insert(latestState).values({
        accountId: a.id,
        lastSeen: new Date(NOW.getTime() - opts.lastSeenAgoS * S),
        tickDelay: opts.tickDelay ?? null,
        gameState: 'LOGGED_IN',
      });
    }
    return a.id;
  }

  async function openSession(accountId: number, lastSeenAgoS: number): Promise<string> {
    const lastSeenAt = new Date(NOW.getTime() - lastSeenAgoS * S);
    const [row] = await t.db
      .insert(playSessions)
      .values({ accountId, startedAt: new Date(NOW.getTime() - 3 * 3600 * S), lastSeenAt })
      .returning({ id: playSessions.id });
    if (!row) throw new Error('no session');
    return row.id;
  }

  async function sessionRow(id: string) {
    const [row] = await t.db.select().from(playSessions).where(eq(playSessions.id, id));
    return row;
  }

  it('closes sessions silent longer than the presence timeout at their last payload', async () => {
    // Unknown tick delay: 25 minutes.
    const unknownStale = await openSession(await account({ lastSeenAgoS: 26 * 60 }), 26 * 60);
    const unknownFresh = await openSession(await account({ lastSeenAgoS: 24 * 60 }), 24 * 60);
    const unknownEdge = await openSession(await account({ lastSeenAgoS: 1500 }), 1500);
    // tick delay 600 → floor(600 × 1.86) = 1116 s.
    const slowStale = await openSession(
      await account({ lastSeenAgoS: 1117, tickDelay: 600 }),
      1117,
    );
    const slowFresh = await openSession(
      await account({ lastSeenAgoS: 1115, tickDelay: 600 }),
      1115,
    );
    // tick delay 10 → 18 s, raised to the 60 s floor.
    const fastStale = await openSession(await account({ lastSeenAgoS: 61, tickDelay: 10 }), 61);
    const fastFresh = await openSession(await account({ lastSeenAgoS: 59, tickDelay: 10 }), 59);
    // Presence refreshed by a non-session payload (e.g. the login screen) keeps the session open.
    const presenceFresh = await openSession(await account({ lastSeenAgoS: 30 }), 2 * 3600);
    // No latest_state row: the session's own last payload decides.
    const noState = await openSession(await account({ lastSeenAgoS: null }), 30 * 60);
    const noStateFresh = await openSession(await account({ lastSeenAgoS: null }), 60);

    const ended = await openSession(await account({ lastSeenAgoS: 5 * 3600 }), 5 * 3600);
    const endedAt = new Date(NOW.getTime() - 4 * 3600 * S);
    await t.db
      .update(playSessions)
      .set({ endedAt, endReason: 'logout' })
      .where(eq(playSessions.id, ended));

    const result = await closeStaleSessions(t.db, { now: NOW });

    expect(result).toEqual({ closed: 4 });
    for (const [id, agoS] of [
      [unknownStale, 26 * 60],
      [slowStale, 1117],
      [fastStale, 61],
      [noState, 30 * 60],
    ] as const) {
      expect(await sessionRow(id)).toMatchObject({
        endedAt: new Date(NOW.getTime() - agoS * S),
        endReason: 'timeout',
      });
    }
    for (const id of [
      unknownFresh,
      unknownEdge,
      slowFresh,
      fastFresh,
      presenceFresh,
      noStateFresh,
    ]) {
      expect(await sessionRow(id)).toMatchObject({ endedAt: null, endReason: null });
    }
    expect(await sessionRow(ended)).toMatchObject({ endedAt, endReason: 'logout' });

    await expect(closeStaleSessions(t.db, { now: NOW })).resolves.toEqual({ closed: 0 });
  });
});

describe('closeStaleSessions with plugin payloads', () => {
  let h: Harness;

  beforeAll(() => {
    h = createHarness(t);
  });

  async function openSessions(accountId: number) {
    return t.db
      .select({ endedAt: playSessions.endedAt, endReason: playSessions.endReason })
      .from(playSessions)
      .where(eq(playSessions.accountId, accountId));
  }

  it('times a LOGGED_IN session out after floor(tickDelay × 1.86) s of silence (D-28)', async () => {
    const device = await h.seedDevice();
    const hash = newHash();
    const body = wire('snapshot-normal', { hash });
    expect(body.tickDelay).toBe(100);
    await h.send(device, body);
    const accountId = (await h.accountIdByHash(hash))!;
    const recv = h.clock.now;
    const timeoutMs = presenceTimeoutSeconds(100) * S;
    expect(timeoutMs).toBe(186 * S);

    await closeStaleSessions(t.db, { now: new Date(recv + timeoutMs) });
    expect(await openSessions(accountId)).toEqual([{ endedAt: null, endReason: null }]);

    await closeStaleSessions(t.db, { now: new Date(recv + timeoutMs + S) });
    expect(await openSessions(accountId)).toEqual([
      { endedAt: new Date(recv), endReason: 'timeout' },
    ]);
  });

  it.each([
    ['logout', 'logout'],
    ['shutdown', 'shutdown'],
    // No player: the clientShutdown still closes the sessions of the device that sent it (D-29).
    ['logout-client-start-no-player', 'logout'],
    ['disabled-login-screen', 'disabled'],
  ] as const)('leaves a session that %s closed alone', async (fixture, reason) => {
    const device = await h.seedDevice();
    const hash = newHash();
    await h.send(device, wire('snapshot-normal', { hash }));
    const closing = wire(fixture, { hash, freshEventIds: true });
    closing.timestamp = h.clock.now + 30 * S;
    await h.send(device, closing);
    const accountId = (await h.accountIdByHash(hash))!;
    const [before] = await openSessions(accountId);
    expect(before?.endReason).toBe(reason);

    await closeStaleSessions(t.db, { now: new Date(h.clock.now + 3600 * S) });
    expect(await openSessions(accountId)).toEqual([before]);
  });

  it('keeps a session open on an opted-in special world, which still reports (D-45)', async () => {
    const device = await h.seedDevice();
    const hash = newHash();
    await h.send(device, wire('snapshot-normal', { hash }));
    const special = wire('special-world-seasonal', { hash, freshEventIds: true });
    const at = h.clock.now + 170 * S;
    special.timestamp = at - 1_000;
    await h.send(device, special);
    const accountId = (await h.accountIdByHash(hash))!;

    await closeStaleSessions(t.db, { now: new Date(at + 180 * S) });
    expect(await openSessions(accountId)).toEqual([{ endedAt: null, endReason: null }]);
    await closeStaleSessions(t.db, { now: new Date(at + 187 * S) });
    expect(await openSessions(accountId)).toEqual([
      { endedAt: new Date(at), endReason: 'timeout' },
    ]);
  });
});
