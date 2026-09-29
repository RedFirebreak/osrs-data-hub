import { accountLinks, devices, events, osrsAccounts, playSessions, rawPayloads } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { and, eq, isNull } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHANNELS } from '../notify';
import { offboardUser } from '../offboarding';
import { ACCOUNT_LOCK_CLASS } from './store';
import { captureLogger, createHarness, newHash, wire, type Harness } from './test-support';

let t: TestDatabase;
let h: Harness;

beforeAll(async () => {
  t = await createTestDatabase('ingest_concurrency');
  h = createHarness(t);
});

afterAll(async () => {
  await t.drop();
});

describe('two concurrent first payloads for a new account (DB-9)', () => {
  it('both succeed and create exactly one account, one owner, one open session', async () => {
    for (let round = 0; round < 5; round++) {
      const [a, b] = [await h.seedDevice(), await h.seedDevice()];
      const hash = newHash();
      const first = wire('snapshot-normal', { hash });
      const second = wire('event-loot', { hash, freshEventIds: true });

      const results = await Promise.all([h.send(a, first), h.send(b, second)]);

      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const accounts = await t.db
        .select()
        .from(osrsAccounts)
        .where(eq(osrsAccounts.accountHash, hash));
      expect(accounts).toHaveLength(1);
      const accountId = accounts[0]?.id ?? -1;
      const links = await t.db
        .select({ userId: accountLinks.userId, role: accountLinks.role })
        .from(accountLinks)
        .where(eq(accountLinks.accountId, accountId));
      expect(links).toHaveLength(2);
      expect(links.filter((l) => l.role === 'owner')).toEqual([
        { userId: accounts[0]?.ownerUserId, role: 'owner' },
      ]);
      const open = await t.db
        .select({ id: playSessions.id })
        .from(playSessions)
        .where(and(eq(playSessions.accountId, accountId), isNull(playSessions.endedAt)));
      expect(open).toHaveLength(1);
      expect(
        await t.db.select({ id: events.id }).from(events).where(eq(events.accountId, accountId)),
      ).toHaveLength(1);
    }
  });

  it('concurrent payloads that create new hypertable chunks do not deadlock', async () => {
    // Creating a chunk locks the FK target osrs_accounts (ShareRowExclusiveLock); ingest writes
    // osrs_accounts late in the transaction, so existing accounts never wait in a cycle on it.
    const { logger, lines } = captureLogger();
    const g = createHarness(t, { logger });
    const devices = await Promise.all([1, 2, 3, 4, 5].map(() => g.seedDevice()));
    const hashes = devices.map(() => newHash());
    await Promise.all(
      devices.map((d, i) => g.send(d, wire('snapshot-normal', { hash: hashes[i] }))),
    );
    lines.length = 0;

    for (let week = 1; week <= 3; week++) {
      const at = 1_790_000_000_000 + week * 8 * 86_400_000;
      const results = await Promise.all(
        devices.map((d, i) => {
          const body = wire('snapshot-normal', { hash: hashes[i] });
          body.timestamp = at - 1_000;
          return g.send(d, JSON.stringify(body), { at });
        }),
      );
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    }
    expect(lines.filter((l) => l.msg === 'ingest: retrying')).toEqual([]);
  });

  it('brand-new accounts arriving while chunks are created do not deadlock either', async () => {
    // A new account's transaction used to INSERT osrs_accounts at its start and hold that lock to
    // commit; a concurrent payload creating a chunk (ShareRowExclusiveLock on osrs_accounts) then
    // deadlocked with it, and the retries collided again (~15 % of these payloads ended as 503).
    // Then newcomers (XP chunk, then location chunk) still deadlocked with existing accounts
    // (location chunk only) in about one run in five, until chunk creation was serialized (D-58).
    const { logger, lines } = captureLogger();
    const g = createHarness(t, { logger });
    const existing = await Promise.all([1, 2, 3, 4].map(() => g.seedDevice()));
    const hashes = existing.map(() => newHash());
    await Promise.all(
      existing.map((d, i) => g.send(d, wire('snapshot-normal', { hash: hashes[i] }))),
    );
    lines.length = 0;

    const statuses: number[] = [];
    for (let round = 1; round <= 6; round++) {
      // Past the last round's xp_samples (7 d) and location_samples (1 d) chunks.
      const at = 1_790_000_000_000 + 100 * 86_400_000 + round * 8 * 86_400_000;
      const newcomers = await Promise.all([1, 2, 3, 4].map(() => g.seedDevice()));
      const at1 = (hash: string) => {
        const body = wire('snapshot-normal', { hash });
        body.timestamp = at - 1_000;
        return JSON.stringify(body);
      };
      const results = await Promise.all([
        ...existing.map((d, i) => g.send(d, at1(hashes[i] ?? ''), { at })),
        ...newcomers.map((d) => g.send(d, at1(newHash()), { at })),
      ]);
      statuses.push(...results.map((r) => r.status));
    }
    expect(statuses.filter((s) => s !== 200)).toEqual([]);
    expect(lines.filter((l) => l.pgCode === '40P01')).toEqual([]);
  }, 60_000);

  it('the same payload twice at once stores its events once', async () => {
    const device = await h.seedDevice();
    const body = wire('event-diary-repeat', { hash: newHash(), freshEventIds: true });
    const results = await Promise.all([h.send(device, body), h.send(device, body)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const [account] = await t.db
      .select({ id: osrsAccounts.id })
      .from(osrsAccounts)
      .where(eq(osrsAccounts.accountHash, body.player?.accountHash as string));
    const rows = await t.db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.accountId, account?.id ?? -1));
    expect(rows).toHaveLength(2);
  });
});

describe('NOTIFY (D-32)', () => {
  let listener: pg.Client;
  const received: { channel: string; payload: unknown }[] = [];

  beforeAll(async () => {
    listener = new pg.Client({ connectionString: t.url });
    await listener.connect();
    listener.on('notification', (n) => {
      received.push({ channel: n.channel, payload: JSON.parse(n.payload ?? 'null') });
    });
    await listener.query(`LISTEN ${CHANNELS.events}`);
    await listener.query(`LISTEN ${CHANNELS.state}`);
  });

  afterAll(async () => {
    await listener.end();
  });

  /** Waits until `n` notifications arrived (they are delivered asynchronously after commit). */
  async function waitFor(n: number): Promise<void> {
    for (let i = 0; i < 100 && received.length < n; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it('announces committed events and state, with first-data for the device', async () => {
    received.length = 0;
    const device = await h.seedDevice();
    const body = wire('event-levelup-multi', { hash: newHash(), freshEventIds: true });
    expect((await h.send(device, body)).status).toBe(200);
    await waitFor(2);

    const [account] = await t.db
      .select({ id: osrsAccounts.id })
      .from(osrsAccounts)
      .where(eq(osrsAccounts.accountHash, body.player?.accountHash as string));
    const accountId = account?.id;
    const eventsMsg = received.find((r) => r.channel === CHANNELS.events);
    const stateMsg = received.find((r) => r.channel === CHANNELS.state);
    expect(stateMsg?.payload).toEqual({ accountId, deviceId: device.id, firstDataForDevice: true });
    const seqs = (eventsMsg?.payload as { accountId: number; seqs: number[] }).seqs;
    expect(eventsMsg?.payload).toEqual({ accountId, seqs: expect.any(Array) as unknown });
    expect(seqs).toHaveLength(3);
    // Delivered after commit: the rows are visible to another connection.
    const visible = await listener.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM events WHERE seq = ANY($1::bigint[])',
      [seqs],
    );
    expect(visible.rows[0]?.n).toBe(3);

    received.length = 0;
    const again = wire('snapshot-normal', { hash: body.player?.accountHash as string });
    again.timestamp = (body.timestamp as number) + 60_000;
    await h.send(device, again);
    await waitFor(1);
    expect(received).toEqual([
      {
        channel: CHANNELS.state,
        payload: { accountId, deviceId: device.id, firstDataForDevice: false },
      },
    ]);
  });

  it('a shutdown without identity announces each account whose session it closed', async () => {
    const device = await h.seedDevice();
    const hash = newHash();
    const snapshot = wire('snapshot-normal', { hash });
    await h.send(device, snapshot);
    await waitFor(1);
    received.length = 0;

    const res = await h.send(device, wire('logout-client-start-no-player'), {
      at: (snapshot.timestamp as number) + 60_000,
    });
    expect(res.status).toBe(200);
    await waitFor(1);

    const [account] = await t.db
      .select({ id: osrsAccounts.id })
      .from(osrsAccounts)
      .where(eq(osrsAccounts.accountHash, hash));
    expect(received).toEqual([
      { channel: CHANNELS.state, payload: { accountId: account?.id, deviceId: device.id } },
    ]);
  });

  it('a first-login burst from one device reports first data exactly once', async () => {
    // Login sends a snapshot plus HP/prayer StatChanged payloads in the same tick (PLUGIN-1).
    const device = await h.seedDevice();
    const hash = newHash();
    const burst = [0, 1, 2, 3].map((i) => {
      const body = wire('snapshot-normal', { hash });
      body.timestamp = (body.timestamp as number) + i;
      return JSON.stringify(body);
    });
    await new Promise((r) => setTimeout(r, 100));
    received.length = 0;

    const results = await Promise.all(
      burst.map((b) => h.send(device, b, { at: 1_790_600_000_000 })),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    await waitFor(4);

    const states = received.filter((r) => r.channel === CHANNELS.state);
    expect(states).toHaveLength(4);
    expect(
      states.filter((s) => (s.payload as { firstDataForDevice?: boolean }).firstDataForDevice),
    ).toHaveLength(1);
    const accounts = await t.db
      .select({ id: osrsAccounts.id })
      .from(osrsAccounts)
      .where(eq(osrsAccounts.accountHash, hash));
    expect(accounts).toHaveLength(1);
    const open = await t.db
      .select({ id: playSessions.id })
      .from(playSessions)
      .where(and(eq(playSessions.accountId, accounts[0]?.id ?? -1), isNull(playSessions.endedAt)));
    expect(open).toHaveLength(1);
  });

  it('announces nothing for a rolled-back (blocked) payload', async () => {
    const owner = await h.seedDevice();
    const blocked = await h.seedDevice();
    const hash = newHash();
    await h.send(owner, wire('snapshot-normal', { hash }));
    await h.send(blocked, wire('snapshot-world-hop', { hash }));
    await t.db
      .update(accountLinks)
      .set({ blocked: true })
      .where(eq(accountLinks.userId, blocked.userId));
    await new Promise((r) => setTimeout(r, 200)); // let the notifications of the setup arrive
    received.length = 0;

    expect((await h.send(blocked, wire('event-loot', { hash, freshEventIds: true }))).status).toBe(
      200,
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toEqual([]);
  });
});

describe('a shutdown without identity next to an ingest of the same account', () => {
  it('waits for the account lock instead of deadlocking on latest_state/play_sessions', async () => {
    const device = await h.seedDevice();
    const hash = newHash();
    const snapshot = wire('snapshot-normal', { hash });
    await h.send(device, snapshot);
    const [account] = await t.db
      .select({ id: osrsAccounts.id })
      .from(osrsAccounts)
      .where(eq(osrsAccounts.accountHash, hash));
    const accountId = account?.id ?? -1;

    // An ingest transaction as store.ts runs it: account lock, latest_state upsert, …, then the
    // open session FOR UPDATE.
    const ingest = new pg.Client({ connectionString: t.url });
    await ingest.connect();
    try {
      await ingest.query('BEGIN');
      await ingest.query('SELECT pg_advisory_xact_lock($1::int4, $2::int4)', [
        ACCOUNT_LOCK_CLASS,
        accountId,
      ]);
      await ingest.query('UPDATE latest_state SET tick_delay = tick_delay WHERE account_id = $1', [
        accountId,
      ]);

      const closing = h.send(device, wire('logout-client-start-no-player'), {
        at: (snapshot.timestamp as number) + 60_000,
      });
      await new Promise((r) => setTimeout(r, 300));
      await ingest.query(
        'SELECT id FROM play_sessions WHERE account_id = $1 AND ended_at IS NULL FOR UPDATE',
        [accountId],
      );
      await ingest.query('COMMIT');

      expect((await closing).status).toBe(200);
      const [session] = await t.db
        .select()
        .from(playSessions)
        .where(eq(playSessions.accountId, accountId));
      expect(session?.endReason).toBe('logout');
    } finally {
      await ingest.end();
    }
  });
});

describe('transient failures (D-19, PLUGIN-4)', () => {
  it('a per-account lock held past lock_timeout → 503 + Retry-After 30, archived; a retry succeeds', async () => {
    const device = await h.seedDevice();
    const hash = newHash();
    await h.send(device, wire('snapshot-normal', { hash }));
    const [account] = await t.db
      .select({ id: osrsAccounts.id })
      .from(osrsAccounts)
      .where(eq(osrsAccounts.accountHash, hash));
    const accountId = account?.id ?? -1;

    const holder = new pg.Client({ connectionString: t.url });
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1::int4, $2::int4)', [
        ACCOUNT_LOCK_CLASS,
        accountId,
      ]);
      const loot = wire('event-loot', { hash, freshEventIds: true });
      const started = Date.now();
      const res = await h.send(device, loot);
      const waited = Date.now() - started;

      expect(res).toEqual({
        status: 503,
        body: { ok: false, error: 'temporarily_unavailable' },
        headers: { 'Retry-After': '30' },
      });
      expect(waited).toBeGreaterThanOrEqual(2_900);
      expect(waited).toBeLessThan(8_000);
      const archived = await t.db
        .select()
        .from(rawPayloads)
        .where(and(eq(rawPayloads.deviceId, device.id), eq(rawPayloads.status, 503)));
      expect(archived).toMatchObject([
        { meta: { error: 'temporarily_unavailable', pgCode: '55P03' } },
      ]);
      expect(
        await t.db.select({ id: events.id }).from(events).where(eq(events.accountId, accountId)),
      ).toEqual([]);

      await holder.query('SELECT pg_advisory_unlock($1::int4, $2::int4)', [
        ACCOUNT_LOCK_CLASS,
        accountId,
      ]);
      expect((await h.send(device, loot)).status).toBe(200);
      expect(
        await t.db.select({ id: events.id }).from(events).where(eq(events.accountId, accountId)),
      ).toHaveLength(1);
    } finally {
      await holder.end();
    }
  });
});

/** Waits until `n` backends of the test database are waiting for a lock. */
async function waitForLockWaiters(n: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const result = await t.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((result.rows[0]?.n ?? 0) >= n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`fewer than ${n} backends waiting for a lock`);
}

async function accountByHash(hash: string) {
  const [row] = await t.db.select().from(osrsAccounts).where(eq(osrsAccounts.accountHash, hash));
  return row;
}

describe('a revoke or an offboarding while a payload is in flight', () => {
  it('a device revoked while its payload waits for the account lock → 401, nothing stored', async () => {
    const device = await h.seedDevice();
    const hash = newHash();
    await h.send(device, wire('snapshot-normal', { hash }));
    const accountId = (await accountByHash(hash))?.id ?? -1;

    const holder = new pg.Client({ connectionString: t.url });
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1::int4, $2::int4)', [
        ACCOUNT_LOCK_CLASS,
        accountId,
      ]);
      const pending = h.send(device, wire('event-loot', { hash, freshEventIds: true }));
      await waitForLockWaiters(1);
      await t.db
        .update(devices)
        .set({ revokedAt: new Date(), revokedReason: 'user' })
        .where(eq(devices.id, device.id));
      await holder.query('SELECT pg_advisory_unlock($1::int4, $2::int4)', [
        ACCOUNT_LOCK_CLASS,
        accountId,
      ]);

      expect((await pending).status).toBe(401);
      expect(
        await t.db.select({ id: events.id }).from(events).where(eq(events.accountId, accountId)),
      ).toEqual([]);
    } finally {
      await holder.end();
    }
  });

  it('an offboarding that commits first refuses the payload (401): no owner, no link', async () => {
    const device = await h.seedDevice();
    const hash = newHash();
    // What offboardUser does first: lock the user row, set grace, revoke the devices.
    const offboarding = new pg.Client({ connectionString: t.url });
    await offboarding.connect();
    try {
      await offboarding.query('BEGIN');
      await offboarding.query('SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE', [
        device.userId,
      ]);
      const pending = h.send(device, wire('snapshot-normal', { hash }));
      await waitForLockWaiters(1);
      await offboarding.query(
        `UPDATE users SET status = 'grace', grace_until = now() + interval '30 days' WHERE id = $1`,
        [device.userId],
      );
      await offboarding.query(
        `UPDATE devices SET revoked_at = now(), revoked_reason = 'offboarding' WHERE user_id = $1`,
        [device.userId],
      );
      await offboarding.query('COMMIT');

      expect((await pending).status).toBe(401);
      // The account row is created before the transaction (TSDB-12); nothing else is.
      const account = await accountByHash(hash);
      expect(account?.ownerUserId).toBeNull();
      expect(
        await t.db
          .select()
          .from(accountLinks)
          .where(eq(accountLinks.accountId, account?.id ?? -1)),
      ).toEqual([]);
    } finally {
      await offboarding.end();
    }
  });

  it('an offboarding that starts while a new account is being claimed waits, then hides it', async () => {
    const device = await h.seedDevice();
    const hash = newHash();
    // Pause the payload after its user and account locks: hold its device row.
    const holder = new pg.Client({ connectionString: t.url });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM devices WHERE id = $1 FOR UPDATE', [device.id]);
      const pending = h.send(device, wire('snapshot-normal', { hash }));
      await waitForLockWaiters(1);
      const offboarding = offboardUser(t.db, {
        userId: device.userId,
        reason: 'left_guild',
        graceDays: 30,
      });
      await waitForLockWaiters(2);
      await holder.query('COMMIT');

      expect((await pending).status).toBe(200);
      const result = await offboarding;
      const account = await accountByHash(hash);
      // The payload made the user owner; the offboarding saw that and hid the account (§14.3).
      expect(result.hidden).toEqual([account?.id]);
      expect(account).toMatchObject({ ownerUserId: device.userId, status: 'hidden' });
    } finally {
      await holder.end();
    }
  });
});
