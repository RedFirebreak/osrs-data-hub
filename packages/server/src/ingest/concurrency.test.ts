import { accountLinks, events, osrsAccounts, playSessions, rawPayloads } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { and, eq, isNull } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHANNELS } from '../notify';
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
    await waitFor(10);
    received.length = 0;

    expect((await h.send(blocked, wire('event-loot', { hash, freshEventIds: true }))).status).toBe(
      200,
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toEqual([]);
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
