import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { getDb } from '@hub/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestMetrics } from '../metrics';
import { CHANNELS, notifyEvents, notifyPairing, notifyState } from '../notify';
import { LiveHub } from './hub';
import {
  ensureLiveListener,
  LIVE_LISTENER_APPLICATION_NAME,
  parseLiveNotification,
  reconnectDelayMs,
  startLiveListener,
  type LiveListener,
  type LiveSink,
} from './listener';
import type { LiveEventMessage } from './messages';
import { captureLogger, fakeSubscriber, seedAccount, seedEvent, seedUser } from './test-support';

const CODE_ID = '01900000-0000-7000-8000-00000000000c';
const DEVICE_ID = '01900000-0000-7000-8000-00000000000d';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase('live-listener');
});

afterAll(async () => {
  await t.drop();
});

function fakeSink() {
  return {
    onEvents: vi.fn<LiveSink['onEvents']>(async () => {}),
    onState: vi.fn<LiveSink['onState']>(async () => {}),
    onPairing: vi.fn<LiveSink['onPairing']>(),
    onReconnect: vi.fn<LiveSink['onReconnect']>(),
  };
}

/** Backend pids of this database's listener connections. */
async function listenerPids(): Promise<number[]> {
  const res = await t.db.execute<{ pid: number }>(sql`
    SELECT pid FROM pg_stat_activity
    WHERE application_name = ${LIVE_LISTENER_APPLICATION_NAME} AND datname = current_database()`);
  return res.rows.map((r) => r.pid);
}

async function notifyRaw(channel: string, payload: string): Promise<void> {
  await t.db.execute(sql`SELECT pg_notify(${channel}, ${payload})`);
}

async function started(sink: LiveSink, logger = captureLogger().logger): Promise<LiveListener> {
  const listener = startLiveListener({ connectionString: t.url, hub: sink, logger });
  await vi.waitFor(() => expect(listener.connected()).toBe(true), { timeout: 5_000 });
  return listener;
}

describe('reconnectDelayMs', () => {
  it('backs off from 1 s, doubling, up to 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 100].map(reconnectDelayMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
  });
});

describe('parseLiveNotification', () => {
  it('parses the payloads of notify.ts', () => {
    expect(parseLiveNotification(CHANNELS.events, '{"accountId":3,"seqs":[5,6]}')).toEqual({
      channel: 'events',
      payload: { accountId: 3, seqs: [5, 6] },
    });
    expect(
      parseLiveNotification(
        CHANNELS.state,
        JSON.stringify({ accountId: 3, deviceId: DEVICE_ID, firstDataForDevice: true }),
      ),
    ).toEqual({
      channel: 'state',
      payload: { accountId: 3, deviceId: DEVICE_ID, firstDataForDevice: true },
    });
    // A missing deviceId is null.
    expect(parseLiveNotification(CHANNELS.state, '{"accountId":3}')).toEqual({
      channel: 'state',
      payload: { accountId: 3, deviceId: null },
    });
    const consumed = { kind: 'consumed', userId: 'u1', codeId: CODE_ID, deviceId: DEVICE_ID };
    expect(parseLiveNotification(CHANNELS.pairing, JSON.stringify(consumed))).toEqual({
      channel: 'pairing',
      payload: consumed,
    });
    const outdated = { kind: 'outdated_plugin', userId: 'u1', codeId: CODE_ID, version: null };
    expect(parseLiveNotification(CHANNELS.pairing, JSON.stringify(outdated))?.payload).toEqual(
      outdated,
    );
  });

  it.each([
    [CHANNELS.events, undefined],
    [CHANNELS.events, ''],
    [CHANNELS.events, 'not json'],
    [CHANNELS.events, 'null'],
    [CHANNELS.events, '[1,2]'],
    [CHANNELS.events, '{"accountId":"3","seqs":[1]}'],
    [CHANNELS.events, '{"accountId":3,"seqs":[]}'],
    [CHANNELS.events, '{"accountId":3,"seqs":[1.5]}'],
    [CHANNELS.events, '{"accountId":3,"seqs":[9007199254740993]}'],
    [CHANNELS.state, '{"accountId":-1,"deviceId":null}'],
    [CHANNELS.state, '{"accountId":3,"deviceId":"x\'; drop table users"}'],
    [CHANNELS.state, '{"accountId":3,"deviceId":null,"firstDataForDevice":"yes"}'],
    [CHANNELS.pairing, '{"kind":"stolen","userId":"u1","codeId":"x"}'],
    [
      CHANNELS.pairing,
      `{"kind":"consumed","userId":"","codeId":"${CODE_ID}","deviceId":"${DEVICE_ID}"}`,
    ],
    [CHANNELS.pairing, `{"kind":"consumed","userId":"u1","codeId":"${CODE_ID}"}`],
    ['hub_other', '{"accountId":3,"seqs":[1]}'],
  ])('rejects %s %s', (channel, payload) => {
    expect(parseLiveNotification(channel, payload)).toBeNull();
  });
});

describe('startLiveListener', () => {
  it('delivers a notification only after the writing transaction commits (D-32)', async () => {
    const sink = fakeSink();
    const listener = await started(sink);
    try {
      await t.db.transaction(async (tx) => {
        await notifyEvents(tx, { accountId: 7, seqs: [11, 12] });
        await sleep(200);
        expect(sink.onEvents).not.toHaveBeenCalled();
      });
      await vi.waitFor(() =>
        expect(sink.onEvents).toHaveBeenCalledWith({ accountId: 7, seqs: [11, 12] }),
      );

      // A rolled-back notification never arrives; a later committed one does.
      await t.db
        .transaction(async (tx) => {
          await notifyEvents(tx, { accountId: 8, seqs: [1] });
          throw new Error('rollback');
        })
        .catch(() => {});
      await notifyState(t.db, { accountId: 9, deviceId: DEVICE_ID, firstDataForDevice: true });
      await vi.waitFor(() =>
        expect(sink.onState).toHaveBeenCalledWith({
          accountId: 9,
          deviceId: DEVICE_ID,
          firstDataForDevice: true,
        }),
      );
      expect(sink.onEvents).toHaveBeenCalledTimes(1);

      await notifyPairing(t.db, {
        kind: 'outdated_plugin',
        userId: 'u1',
        codeId: CODE_ID,
        version: '1.4',
      });
      await vi.waitFor(() =>
        expect(sink.onPairing).toHaveBeenCalledWith({
          kind: 'outdated_plugin',
          userId: 'u1',
          codeId: CODE_ID,
          version: '1.4',
        }),
      );
    } finally {
      await listener.stop();
    }
  });

  it('ignores malformed payloads and survives a failing hub', async () => {
    const sink = fakeSink();
    sink.onPairing.mockImplementation(() => {
      throw new Error('hub bug');
    });
    sink.onEvents.mockRejectedValue(new Error('hub bug'));
    const { logger, lines } = captureLogger();
    const listener = await started(sink, logger);
    try {
      await notifyRaw(CHANNELS.events, 'not json');
      await notifyRaw(CHANNELS.state, '{"accountId":"1"}');
      await notifyRaw(CHANNELS.pairing, '{"kind":"nope"}');
      await notifyPairing(t.db, {
        kind: 'consumed',
        userId: 'u',
        codeId: CODE_ID,
        deviceId: DEVICE_ID,
      });
      await notifyEvents(t.db, { accountId: 1, seqs: [1] });
      await notifyState(t.db, { accountId: 2, deviceId: null });

      await vi.waitFor(() => {
        expect(sink.onState).toHaveBeenCalledTimes(1);
        expect(lines.filter((l) => l.includes('live: hub failed'))).toHaveLength(2);
      });
      expect(sink.onState).toHaveBeenCalledWith({ accountId: 2, deviceId: null });
      expect(sink.onPairing).toHaveBeenCalledTimes(1);
      expect(sink.onEvents).toHaveBeenCalledTimes(1);
      expect(lines.filter((l) => l.includes('malformed notification ignored'))).toHaveLength(3);
      expect(listener.connected()).toBe(true);
    } finally {
      await listener.stop();
    }
  });

  it('reconnects after its backend is terminated and tells the hub to resync', async () => {
    const sink = fakeSink();
    const { logger, lines } = captureLogger();
    const listener = await started(sink, logger);
    try {
      // Every successful LISTEN resyncs, the first included (no-op for a hub without streams).
      expect(sink.onReconnect).toHaveBeenCalledTimes(1);
      const [pid] = await listenerPids();
      expect(pid).toBeTypeOf('number');

      await t.db.execute(sql`SELECT pg_terminate_backend(${pid})`);
      await vi.waitFor(() => expect(listener.connected()).toBe(false), { timeout: 2_000 });
      await vi.waitFor(() => expect(sink.onReconnect).toHaveBeenCalledTimes(2), {
        timeout: 5_000,
      });
      expect(listener.connected()).toBe(true);
      const pids = await listenerPids();
      expect(pids).toHaveLength(1);
      expect(pids[0]).not.toBe(pid);
      expect(lines.some((l) => l.includes('reconnecting') && l.includes('"delayMs":1000'))).toBe(
        true,
      );
      // No bound parameters or connection details in the logs (DB-3).
      expect(lines.join('\n')).not.toContain(t.url);

      await notifyEvents(t.db, { accountId: 5, seqs: [3] });
      await vi.waitFor(() =>
        expect(sink.onEvents).toHaveBeenCalledWith({ accountId: 5, seqs: [3] }),
      );
    } finally {
      await listener.stop();
    }
  });

  it('keeps backing off when each new connection is lost right away (no resync storm)', async () => {
    // Every successful LISTEN broadcasts 'resync' and every client then refetches: a connection
    // killed right after it came back must not be retried (and resynced) every second forever.
    const sink = fakeSink();
    const { logger, lines } = captureLogger();
    const listener = await started(sink, logger);
    const delays = () =>
      lines
        .filter((l) => l.includes('reconnecting'))
        .map((l) => (JSON.parse(l) as { delayMs: number }).delayMs);
    try {
      for (let round = 1; round <= 2; round++) {
        const [pid] = await listenerPids();
        await t.db.execute(sql`SELECT pg_terminate_backend(${pid})`);
        await vi.waitFor(() => expect(sink.onReconnect).toHaveBeenCalledTimes(round + 1), {
          timeout: 5_000,
        });
      }
      expect(delays()).toEqual([1000, 2000]);
      expect(listener.connected()).toBe(true);
    } finally {
      await listener.stop();
    }
  });

  it('keeps retrying while the database is unreachable', async () => {
    const sink = fakeSink();
    const { logger, lines } = captureLogger();
    const bad = new URL(t.url);
    bad.pathname = '/hub_t_does_not_exist';
    const listener = startLiveListener({ connectionString: bad.toString(), hub: sink, logger });
    try {
      await vi.waitFor(
        () => expect(lines.filter((l) => l.includes('reconnecting')).length).toBeGreaterThan(1),
        { timeout: 6_000 },
      );
      expect(listener.connected()).toBe(false);
      expect(sink.onReconnect).not.toHaveBeenCalled();
      expect(lines.some((l) => l.includes('"pgCode":"3D000"'))).toBe(true);
    } finally {
      await listener.stop();
    }
  });

  it('stop() ends the connection for good', async () => {
    const sink = fakeSink();
    const listener = await started(sink);
    expect(await listenerPids()).toHaveLength(1);

    await listener.stop();
    await listener.stop();

    expect(listener.connected()).toBe(false);
    await sleep(1_500); // longer than the first reconnect delay
    expect(await listenerPids()).toEqual([]);
    await notifyEvents(t.db, { accountId: 1, seqs: [1] });
    await sleep(100);
    expect(sink.onEvents).not.toHaveBeenCalled();
  });

  it('stop() during the first connect leaves nothing behind', async () => {
    const listener = startLiveListener({
      connectionString: t.url,
      hub: fakeSink(),
      logger: captureLogger().logger,
    });
    await listener.stop();
    await sleep(500);
    expect(listener.connected()).toBe(false);
    expect(await listenerPids()).toEqual([]);
  });

  it('feeds a real LiveHub end to end: a committed event reaches a subscribed stream', async () => {
    const user = await seedUser(t.db);
    const account = await seedAccount(t.db, { name: 'Zezima', ownerUserId: user.userId });
    const hub = new LiveHub({
      db: t.db,
      logger: captureLogger().logger,
      metrics: createTestMetrics(),
    });
    const sub = fakeSubscriber(user);
    hub.subscribe(sub);
    const listener = await started(hub);
    try {
      expect(sub.messages('resync')).toHaveLength(1);
      const e = await t.db.transaction(async (tx) => {
        const row = await seedEvent(tx, account.id, {
          occurredAt: new Date(),
          valueGp: 1_000_000,
        });
        await notifyEvents(tx, { accountId: account.id, seqs: [row.seq] });
        return row;
      });
      await vi.waitFor(() => expect(sub.messages('event')).toHaveLength(1));
      const [msg] = sub.messages('event');
      expect(msg?.id).toBe(String(e.seq));
      expect((msg?.data as LiveEventMessage).event.id).toBe(e.id);
      expect((msg?.data as LiveEventMessage).toast).toBe(true);
    } finally {
      await listener.stop();
    }
  });
});

describe('ensureLiveListener', () => {
  it('starts one listener per process from DATABASE_URL, forwarding to getLiveHub()', async () => {
    const saved = process.env.DATABASE_URL;
    const savedLevel = process.env.LOG_LEVEL;
    const g = globalThis as {
      __hubLiveListener?: LiveListener;
      __hubLiveHub?: unknown;
      __hubDb?: unknown;
      __hubLogger?: unknown;
    };
    process.env.DATABASE_URL = t.url;
    process.env.LOG_LEVEL = 'silent';
    try {
      const a = ensureLiveListener();
      const b = ensureLiveListener();
      expect(b).toBe(a);
      await vi.waitFor(() => expect(a.connected()).toBe(true), { timeout: 5_000 });
      expect(await listenerPids()).toHaveLength(1);
      await a.stop();
    } finally {
      delete g.__hubLiveListener;
      delete g.__hubLiveHub;
      await getDb().pool.end();
      delete g.__hubDb;
      delete g.__hubLogger;
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
      if (savedLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = savedLevel;
    }
  });

  it('throws without DATABASE_URL', () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => ensureLiveListener()).toThrow('DATABASE_URL is not set');
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });
});
