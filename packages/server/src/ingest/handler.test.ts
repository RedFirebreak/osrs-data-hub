import { devices, events, osrsAccounts, rawPayloads, type Db } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { fixtureBody } from '@hub/fixtures';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { handleIngest } from './handler';
import {
  captureLogger,
  counterValue,
  createHarness,
  newHash,
  wire,
  type Harness,
} from './test-support';

let t: TestDatabase;
let h: Harness;

beforeAll(async () => {
  t = await createTestDatabase('ingest_handler');
  h = createHarness(t);
});

afterAll(async () => {
  await t.drop();
});

async function archiveCount(): Promise<number> {
  const [row] = await t.db.select({ n: count() }).from(rawPayloads);
  return row?.n ?? 0;
}

async function archiveRows(deviceId: string) {
  return t.db
    .select()
    .from(rawPayloads)
    .where(eq(rawPayloads.deviceId, deviceId))
    .orderBy(rawPayloads.receivedAt);
}

/** A readBody that must never be called. */
const noBody = () => Promise.reject(new Error('readBody must not be called'));

describe('decommissioned', () => {
  it('answers 410 before anything else, without reading or archiving', async () => {
    const readBody = vi.fn(noBody);
    const gone = createHarness(t, { isDecommissioned: () => Promise.resolve(true) });
    const device = await gone.seedDevice();
    const before = await archiveCount();

    const res = await gone.send(device, wire('snapshot-normal'), { readBody });

    expect(res).toEqual({
      status: 410,
      body: { ok: false, error: 'This hub no longer accepts data.' },
    });
    expect(readBody).not.toHaveBeenCalled();
    expect(await archiveCount()).toBe(before);
    expect(await counterValue(gone.metrics.ingestPayloads, { status: '410' })).toBe(1);
  });
});

describe('authentication (401 only for auth, D-19)', () => {
  const unauthorized = { status: 401, body: { ok: false, error: 'unauthorized' } };

  it('rejects a missing, empty or unknown token', async () => {
    const device = await h.seedDevice();
    const before = await archiveCount();
    for (const token of [null, '', 'f'.repeat(64)]) {
      const readBody = vi.fn(noBody);
      expect(await h.send(device, wire('snapshot-normal'), { token, readBody })).toEqual(
        unauthorized,
      );
      expect(readBody).not.toHaveBeenCalled();
    }
    expect(await archiveCount()).toBe(before);
  });

  it('rejects a revoked device', async () => {
    const device = await h.seedDevice(undefined, { revoked: true });
    expect(await h.send(device, wire('snapshot-normal'), { readBody: noBody })).toEqual(
      unauthorized,
    );
  });

  it('rejects a device whose user is in grace', async () => {
    const userId = await h.seedUser({ status: 'grace' });
    const device = await h.seedDevice(userId);
    expect(await h.send(device, wire('snapshot-normal'), { readBody: noBody })).toEqual(
      unauthorized,
    );
  });
});

describe('version gate', () => {
  it.each([
    ['missing', null, null],
    ['1.4', '1.4', '1.4'],
    ['garbage', 'v1.5', 'v1.5'],
  ])('%s header → 400 plugin_outdated and the device is flagged', async (_, header, stored) => {
    const device = await h.seedDevice();
    const readBody = vi.fn(noBody);
    h.clock.now = 1_790_000_000_000;

    const res = await h.send(device, fixtureBody('snapshot-normal'), { version: header, readBody });

    expect(res).toEqual({ status: 400, body: { ok: false, error: 'plugin_outdated' } });
    expect(readBody).not.toHaveBeenCalled();
    const [row] = await t.db.select().from(devices).where(eq(devices.id, device.id));
    expect(row?.outdatedAt).toEqual(new Date(1_790_000_000_000));
    expect(row?.pluginVersion).toBe(stored);
    expect(await archiveRows(device.id)).toEqual([]);
  });

  it('a later good version clears the flag and records the version', async () => {
    const device = await h.seedDevice();
    await h.send(device, fixtureBody('snapshot-normal'), { version: '1.4' });
    const res = await h.send(device, wire('snapshot-normal', { hash: newHash() }), {
      version: '1.6-SNAPSHOT',
    });
    expect(res.status).toBe(200);
    const [row] = await t.db.select().from(devices).where(eq(devices.id, device.id));
    expect(row?.outdatedAt).toBeNull();
    expect(row?.pluginVersion).toBe('1.6-SNAPSHOT');
  });

  it('truncates the stored version text to 32 characters', async () => {
    const device = await h.seedDevice();
    await h.send(device, fixtureBody('snapshot-normal'), { version: `1.0${'x'.repeat(100)}` });
    const [row] = await t.db.select().from(devices).where(eq(devices.id, device.id));
    expect(row?.pluginVersion).toHaveLength(32);
  });

  it('stores the version text without control characters, as pairing does', async () => {
    const accepted = await h.seedDevice();
    const res = await h.send(accepted, wire('snapshot-normal', { hash: newHash() }), {
      version: ' 1.6\u001b[31m-SNAP\u0085SHOT\u0000\u0007\t',
    });
    expect(res.status).toBe(200);
    const [row] = await t.db.select().from(devices).where(eq(devices.id, accepted.id));
    expect(row?.pluginVersion).toBe('1.6[31m-SNAPSHOT');
    const [archived] = await archiveRows(accepted.id);
    expect(archived?.pluginVersion).toBe('1.6[31m-SNAPSHOT');

    // The outdated path stores the same text; nothing but control characters is no version.
    const outdated = await h.seedDevice();
    await h.send(outdated, fixtureBody('snapshot-normal'), { version: '1.4\u007f\r\n beta' });
    await h.send(accepted, fixtureBody('snapshot-normal'), { version: '\u0000\u001f \u009f' });
    const [flagged] = await t.db.select().from(devices).where(eq(devices.id, outdated.id));
    expect(flagged?.pluginVersion).toBe('1.4 beta');
    const [blank] = await t.db.select().from(devices).where(eq(devices.id, accepted.id));
    expect(blank?.outdatedAt).not.toBeNull();
    expect(blank?.pluginVersion).toBeNull();
  });
});

describe('body limits and parsing', () => {
  it('413 when the body exceeds the cap (reader gets maxBodyBytes)', async () => {
    const device = await h.seedDevice();
    const readBody = vi.fn(() => Promise.resolve(null));
    const res = await h.send(device, fixtureBody('snapshot-normal'), { readBody });
    expect(res).toEqual({ status: 413, body: { ok: false, error: 'payload_too_large' } });
    expect(readBody).toHaveBeenCalledWith(256 * 1024);
    expect(await archiveRows(device.id)).toEqual([]);
  });

  it('400 invalid_payload when the body cannot be read', async () => {
    const device = await h.seedDevice();
    const res = await h.send(device, '{}', {
      readBody: () => Promise.reject(new Error('aborted')),
    });
    expect(res).toEqual({ status: 400, body: { ok: false, error: 'invalid_payload' } });
  });

  it.each([
    ['not_json', '{"player":'],
    ['not_object', '[1,2,3]'],
  ])('%s → 400 invalid_json, archived with status 400', async (error, body) => {
    const device = await h.seedDevice();
    h.clock.now = 1_790_000_100_000;
    const res = await h.send(device, body);
    expect(res).toEqual({ status: 400, body: { ok: false, error: 'invalid_json' } });
    const rows = await archiveRows(device.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 400,
      body,
      meta: { error },
      pluginVersion: '1.5',
      accountId: null,
      receivedAt: new Date(1_790_000_100_000),
    });
  });

  it('counts an archived unparsable body once: not also as rejected without archive (D-83)', async () => {
    const m = createHarness(t);
    const device = await m.seedDevice();
    const at = 1_790_000_800_000;

    expect((await m.send(device, '{"player":', { at })).status).toBe(400);
    expect((await m.send(device, '[1,2,3]', { at: at + 1_000 })).status).toBe(400);
    expect((await m.send(device, '{}', { token: null, at: at + 2_000 })).status).toBe(401);

    // Both bodies are in the archive, still with the parser's error and nothing written over it.
    const rows = await archiveRows(device.id);
    expect(rows.map((r) => [r.status, r.meta])).toEqual([
      [400, { error: 'not_json' }],
      [400, { error: 'not_object' }],
    ]);
    // So the in-memory count holds only the response that left no archive row.
    const [minute] = m.metrics.ingestUnarchived.series(new Date(at), 1);
    expect(minute?.byKey).toEqual({ '401': 1 });
    expect(await counterValue(m.metrics.ingestPayloads, { status: '400' })).toBe(2);
  });

  it('archives a body with a literal NUL (replaced by U+FFFD; a text column rejects NUL)', async () => {
    const device = await h.seedDevice();
    const res = await h.send(device, '{"events":[]}\u0000');
    expect(res.status).toBe(400);
    const [row] = await archiveRows(device.id);
    expect(row?.body).toBe('{"events":[]}�');
  });

  it('archives a payload with escaped \\u0000 as sent and stores the event without it', async () => {
    const device = await h.seedDevice();
    const body = wire('event-unknown-type', { hash: newHash(), freshEventIds: true });
    const event = body.events?.[0] as { data: Record<string, unknown> };
    event.data.questName = 'Nul\u0000Quest';
    const text = JSON.stringify(body);
    expect(text).toContain('\\u0000');

    const res = await h.send(device, text, { at: 1_790_027_001_000 });

    expect(res.status).toBe(200);
    const [row] = await archiveRows(device.id);
    expect(row?.body).toBe(text);
    expect(row?.status).toBe(200);
    const [stored] = await t.db
      .select({ data: events.data })
      .from(events)
      .where(eq(events.accountId, row?.accountId ?? -1));
    expect(stored?.data).toMatchObject({ data: { questName: 'NulQuest' } });
  });
});

describe('rate limit (snapshot-only payloads, handoff §7.6)', () => {
  it('allows a burst of 30, then 429 with an integer Retry-After; event payloads always pass', async () => {
    const device = await h.seedDevice();
    const hash = newHash();
    const snapshot = JSON.stringify(wire('snapshot-normal', { hash }));
    const at = 1_790_000_500_000;

    for (let i = 0; i < 30; i++) {
      expect((await h.send(device, snapshot, { at })).status).toBe(200);
    }
    const before = await archiveRows(device.id);
    const limited = await h.send(device, snapshot, { at });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ ok: false, error: 'rate_limited' });
    // An integer (PLUGIN-5), and the documented 3 s pause (handoff §7.6), although the bucket
    // itself has a token back after 0.2 s.
    expect(limited.headers).toEqual({ 'Retry-After': '3' });
    expect(await archiveRows(device.id)).toHaveLength(before.length);

    const events = wire('event-loot', { hash, freshEventIds: true });
    expect((await h.send(device, events, { at })).status).toBe(200);

    // 1 s later five tokens are back.
    expect((await h.send(device, snapshot, { at: at + 1_000 })).status).toBe(200);
    expect(await counterValue(h.metrics.ingestPayloads, { status: '429' })).toBe(1);
  });

  it('unparsable bodies take a token too: past the bucket they get 429 and are not archived', async () => {
    const device = await h.seedDevice();
    const at = 1_790_000_700_000;
    for (let i = 0; i < 30; i++) {
      expect((await h.send(device, '{"player":', { at })).status).toBe(400);
    }
    expect(await archiveRows(device.id)).toHaveLength(30);

    const limited = await h.send(device, '{"player":', { at });
    expect(limited).toEqual({
      status: 429,
      body: { ok: false, error: 'rate_limited' },
      headers: { 'Retry-After': '3' },
    });
    expect(await archiveRows(device.id)).toHaveLength(30);
    // An event payload still passes the empty bucket.
    const loot = wire('event-loot', { hash: newHash(), freshEventIds: true });
    expect((await h.send(device, loot, { at })).status).toBe(200);
  });

  it('limits per device', async () => {
    const a = await h.seedDevice();
    const b = await h.seedDevice();
    const body = JSON.stringify(wire('login-partial-player'));
    const at = 1_790_000_600_000;
    for (let i = 0; i < 30; i++) await h.send(a, body, { at });
    expect((await h.send(a, body, { at })).status).toBe(429);
    expect((await h.send(b, body, { at })).status).toBe(200);
  });
});

describe('metrics', () => {
  it('counts plugin versions with bounded labels', async () => {
    const m = createHarness(t);
    const device = await m.seedDevice();
    await m.send(device, wire('login-partial-player'), { version: '1.5' });
    await m.send(device, wire('login-partial-player'), { version: null });
    await m.send(device, wire('login-partial-player'), { version: 'abc' });
    await m.send(device, wire('login-partial-player'), { version: '1.6-SNAPSHOT' });
    expect(await counterValue(m.metrics.pluginVersions, { version: '1.5.0' })).toBe(1);
    expect(await counterValue(m.metrics.pluginVersions, { version: 'none' })).toBe(1);
    expect(await counterValue(m.metrics.pluginVersions, { version: 'invalid' })).toBe(1);
    expect(await counterValue(m.metrics.pluginVersions, { version: '1.6.0' })).toBe(1);

    for (let i = 0; i < 40; i++) {
      await m.send(device, '{', { version: `2.${i}` });
    }
    expect(await counterValue(m.metrics.pluginVersions, { version: 'other' })).toBeGreaterThan(0);
  });

  it('does not count the version header of a request that fails authentication', async () => {
    const m = createHarness(t);
    const device = await m.seedDevice();
    await m.send(device, wire('login-partial-player'), { token: 'not-a-token', version: '7.7' });
    await m.send(device, wire('login-partial-player'), { token: null, version: '7.8' });
    expect(await counterValue(m.metrics.pluginVersions, { version: '7.7.0' })).toBe(0);
    expect(await counterValue(m.metrics.pluginVersions, { version: '7.8.0' })).toBe(0);
    expect(await counterValue(m.metrics.ingestPayloads, { status: '401' })).toBe(2);
  });

  it('times and counts every return path', async () => {
    const m = createHarness(t);
    const device = await m.seedDevice();
    await m.send(device, wire('login-partial-player'));
    await m.send(device, '{', {});
    await m.send(device, '{}', { token: null });
    expect(await counterValue(m.metrics.ingestPayloads, { status: '200' })).toBe(1);
    expect(await counterValue(m.metrics.ingestPayloads, { status: '400' })).toBe(1);
    expect(await counterValue(m.metrics.ingestPayloads, { status: '401' })).toBe(1);
    const latency = await m.metrics.ingestLatency.get();
    const samples = latency.values.find(
      (v) => v.metricName === 'hub_ingest_duration_seconds_count',
    );
    expect(samples?.value).toBe(3);
  });
});

describe('error mapping (D-19, D-30)', () => {
  /** A db whose transactions fail with `err`; everything else (archive, auth) works. */
  function failingDb(err: unknown): Db {
    return new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') return () => Promise.reject(err);
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
  }

  /** A db whose first `failures` transactions fail with `err`; later ones run for real. */
  function flakyDb(err: unknown, failures: number): { db: Db; calls: () => number } {
    let calls = 0;
    const db = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return (...args: Parameters<Db['transaction']>) => {
            calls++;
            return calls <= failures ? Promise.reject(err) : target.transaction(...args);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    return { db, calls: () => calls };
  }

  it.each(['40P01', '40001', '23505'])(
    '%s is retried in-process and the payload is stored',
    async (code) => {
      const { logger, lines } = captureLogger();
      const { db, calls } = flakyDb(queryError(code), 2);
      const e = createHarness(t, { db, logger });
      const device = await e.seedDevice();
      const res = await e.send(
        device,
        wire('event-loot', { hash: newHash(), freshEventIds: true }),
      );
      expect(res.status).toBe(200);
      expect(calls()).toBe(3);
      expect(lines.filter((l) => l.msg === 'ingest: retrying')).toMatchObject([
        { attempt: 1, pgCode: code },
        { attempt: 2, pgCode: code },
      ]);
      expect(await archiveRows(device.id)).toMatchObject([{ status: 200, meta: { inserted: 1 } }]);
    },
  );

  it('gives up after three attempts → 503; a lock timeout is not retried', async () => {
    const deadlocks = flakyDb(queryError('40P01'), 10);
    const e = createHarness(t, { db: deadlocks.db });
    const device = await e.seedDevice();
    const body = wire('event-loot', { hash: newHash(), freshEventIds: true });
    expect((await e.send(device, body)).status).toBe(503);
    expect(deadlocks.calls()).toBe(3);

    const timeouts = flakyDb(queryError('55P03'), 10);
    const f = createHarness(t, { db: timeouts.db });
    expect((await f.send(await f.seedDevice(), body)).status).toBe(503);
    expect(timeouts.calls()).toBe(1);
  });

  it('starts no new attempt once the retry budget is spent (PLUGIN-4: stay under 10 s)', async () => {
    // Each attempt spends 1.5 s (lock waits) before its deadlock is detected: a third attempt
    // would take the request to 4.5 s and more under real contention.
    let calls = 0;
    const slow = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return async () => {
            calls++;
            await new Promise((r) => setTimeout(r, 1_500));
            throw queryError('40P01');
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const e = createHarness(t, { db: slow });
    const device = await e.seedDevice();
    const started = performance.now();
    const res = await e.send(device, wire('event-loot', { hash: newHash(), freshEventIds: true }));
    expect(res.status).toBe(503);
    expect(calls).toBe(2);
    expect(performance.now() - started).toBeLessThan(4_000);
  });

  it('an account deleted just before the transaction → 503 for a hash (recreated on resend), 400 for a name', async () => {
    const hash = newHash();
    const deleting = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return async (...args: Parameters<Db['transaction']>) => {
            await target.delete(osrsAccounts).where(eq(osrsAccounts.accountHash, hash));
            return target.transaction(...args);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const e = createHarness(t, { db: deleting });
    const device = await e.seedDevice();
    const loot = wire('event-loot', { hash, name: 'Gone Soon', freshEventIds: true });
    expect((await e.send(device, loot)).status).toBe(503);

    // Recreated by the resend.
    expect((await h.send(device, loot)).status).toBe(200);
    expect(await h.accountIdByHash(hash)).toBeDefined();

    const byName = wire('event-loot', { name: 'Gone Soon', freshEventIds: true });
    delete byName.player?.accountHash;
    expect(await e.send(device, byName)).toEqual({
      status: 400,
      body: { ok: false, error: 'unknown_account' },
    });
  });

  /** Shaped like drizzle's DrizzleQueryError: params in the message, SQLSTATE on the cause (DB-3). */
  function queryError(code: string) {
    return Object.assign(new Error('Failed query: insert …\nparams: SECRET-TOKEN,3222,3218'), {
      cause: Object.assign(new Error('boom from postgres'), { code }),
    });
  }

  async function sendWith(err: unknown) {
    const { logger, lines } = captureLogger();
    const e = createHarness(t, { db: failingDb(err), logger });
    const device = await e.seedDevice();
    const res = await e.send(device, wire('event-loot', { hash: newHash(), freshEventIds: true }));
    const [archived] = await archiveRows(device.id);
    return { res, archived, lines };
  }

  it('transient → 503 + Retry-After 30, archived with the SQLSTATE', async () => {
    const { res, archived, lines } = await sendWith(queryError('40001'));
    expect(res).toEqual({
      status: 503,
      body: { ok: false, error: 'temporarily_unavailable' },
      headers: { 'Retry-After': '30' },
    });
    expect(archived).toMatchObject({
      status: 503,
      meta: { error: 'temporarily_unavailable', pgCode: '40001' },
    });
    expect(JSON.stringify(lines)).not.toContain('SECRET-TOKEN');
  });

  it('a data exception caused by the payload → 400 invalid_payload, never 5xx', async () => {
    const { res, archived, lines } = await sendWith(queryError('22021'));
    expect(res).toEqual({ status: 400, body: { ok: false, error: 'invalid_payload' } });
    expect(archived).toMatchObject({
      status: 400,
      meta: { error: 'invalid_payload', pgCode: '22021' },
    });
    expect(JSON.stringify(lines)).not.toContain('SECRET-TOKEN');
  });

  it('anything else → 500 internal_error with a safe error log', async () => {
    const { res, archived, lines } = await sendWith(queryError('XX000'));
    expect(res).toEqual({ status: 500, body: { ok: false, error: 'internal_error' } });
    expect(archived).toMatchObject({ status: 500, meta: { error: 'internal_error' } });
    const log = lines.find((l) => l.msg === 'ingest: failed');
    expect(log).toMatchObject({ level: 50, pgCode: 'XX000', message: 'boom from postgres' });
    expect(JSON.stringify(lines)).not.toContain('SECRET-TOKEN');
  });

  it('an unexpected error before archiving → 500, nothing archived', async () => {
    const { logger, lines } = captureLogger();
    const e = createHarness(t, {
      logger,
      isDecommissioned: () => {
        throw new TypeError('switch broken');
      },
    });
    const device = await e.seedDevice();
    const res = await e.send(device, wire('snapshot-normal'));
    expect(res.status).toBe(500);
    expect(await archiveRows(device.id)).toEqual([]);
    expect(lines.some((l) => l.msg === 'ingest: failed' && l.error === 'TypeError')).toBe(true);
  });

  it('handleIngest never throws', async () => {
    const e = createHarness(t, { db: failingDb(new Error('x')) });
    const device = await e.seedDevice();
    await expect(
      handleIngest(e.deps, {
        token: device.token,
        versionHeader: '1.5',
        ip: null,
        readBody: () =>
          Promise.resolve(JSON.stringify(wire('snapshot-normal', { hash: newHash() }))),
      }),
    ).resolves.toMatchObject({ status: 500 });
  });
});

describe('archive failures (handoff §7.1.4)', () => {
  /** t.db with insert/update on raw_payloads replaced; everything else runs for real. */
  function archiveDb(opts: { insert?: () => never; update?: () => PromiseLike<unknown> }): Db {
    return new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === 'insert' && opts.insert) {
          return (table: unknown) =>
            table === rawPayloads ? opts.insert?.() : target.insert(table as never);
        }
        if (prop === 'update' && opts.update) {
          const update = opts.update;
          return (table: unknown) =>
            table === rawPayloads
              ? { set: () => ({ where: () => update() }) }
              : target.update(table as never);
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
  }

  const connectionLost = () =>
    Object.assign(new Error('Failed query: insert …\nparams: SECRET'), {
      cause: Object.assign(new Error('terminating connection'), { code: '57P01' }),
    });

  it('a transient failure of the archive insert → 503 + Retry-After 30, nothing stored', async () => {
    const hash = newHash();
    const e = createHarness(t, {
      db: archiveDb({
        insert: () => {
          throw connectionLost();
        },
      }),
    });
    const device = await e.seedDevice();
    const res = await e.send(device, wire('event-loot', { hash, freshEventIds: true }));
    expect(res).toEqual({
      status: 503,
      body: { ok: false, error: 'temporarily_unavailable' },
      headers: { 'Retry-After': '30' },
    });
    expect(await h.accountIdByHash(hash)).toBeUndefined();
  });

  it('a failed outcome update never changes the response and logs only the code', async () => {
    const { logger, lines } = captureLogger();
    const hash = newHash();
    const e = createHarness(t, {
      logger,
      db: archiveDb({ update: () => Promise.reject(connectionLost()) }),
    });
    const device = await e.seedDevice();
    const res = await e.send(device, wire('event-loot', { hash, freshEventIds: true }));
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(await h.accountIdByHash(hash)).toBeDefined();
    expect(lines.find((l) => l.msg === 'ingest: archive update failed')).toMatchObject({
      level: 40,
      pgCode: '57P01',
    });
    expect(JSON.stringify(lines)).not.toContain('SECRET');
  });

  it('a hanging outcome update delays the response by at most about 1 s (PLUGIN-4)', async () => {
    const e = createHarness(t, {
      db: archiveDb({ update: () => new Promise(() => undefined) }),
    });
    const device = await e.seedDevice();
    const started = performance.now();
    const res = await e.send(device, wire('event-loot', { hash: newHash(), freshEventIds: true }));
    expect(res.status).toBe(200);
    expect(performance.now() - started).toBeLessThan(2_500);
  });
});

describe('archive outcome', () => {
  it('records status, account and counts for a stored payload', async () => {
    const device = await h.seedDevice();
    const hash = newHash();
    const res = await h.send(device, wire('event-loot', { hash, freshEventIds: true }));
    expect(res).toEqual({ status: 200, body: { ok: true } });
    const [row] = await archiveRows(device.id);
    const [account] = await t.db
      .select({ id: osrsAccounts.id })
      .from(osrsAccounts)
      .where(eq(osrsAccounts.accountHash, hash));
    expect(row).toMatchObject({
      status: 200,
      accountId: account?.id,
      pluginVersion: '1.5',
      meta: { inserted: 1, duplicates: 0 },
    });
    expect(typeof (row?.meta as { ms?: unknown }).ms).toBe('number');
  });
});
