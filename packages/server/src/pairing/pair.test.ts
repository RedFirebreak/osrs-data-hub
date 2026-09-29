import { sha256Hex } from '@hub/core';
import { auditLog, devices, pairingCodes, createDb, type Db } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from '../logger';
import { createTestMetrics, type HubMetrics } from '../metrics';
import { CHANNELS } from '../notify';
import { insertCodeWithValue } from './codes';
import { createPairLimits, pairRateKey } from './limits';
import { handlePair, outdatedPluginMessage, PAIR_MESSAGES, type PairDeps } from './pair';
import { FakeClock, captureLogger, listen, seedUser } from './test-support';

let t: TestDatabase;
let listener: Awaited<ReturnType<typeof listen>>;

beforeAll(async () => {
  t = await createTestDatabase('pairing');
  listener = await listen(t.url, CHANNELS.pairing);
});

afterAll(async () => {
  await listener.close();
  await t.drop();
});

afterEach(async () => {
  // Deliver anything a test left behind before clearing, so it can't leak into the next test.
  await listener.flush();
  listener.messages.length = 0;
});

const MIN = 60_000;
const OUTDATED_TEXT =
  'HA Exporter 1.5 or newer is required. Restart RuneLite to update the plugin, then press Submit again.';

function setup(overrides: Partial<PairDeps> = {}) {
  const clock = new FakeClock();
  const metrics = createTestMetrics();
  const deps: PairDeps = {
    db: t.db,
    minPluginVersion: '1.5',
    hubName: 'Test Hub',
    limits: createPairLimits({ clock }),
    logger: silentLogger(),
    metrics,
    now: () => clock.date(),
    ...overrides,
  };
  const pair = (body: string | null, opts: { version?: string | null; ip?: string | null } = {}) =>
    handlePair(deps, {
      body,
      versionHeader: opts.version === undefined ? '1.5' : opts.version,
      ip: opts.ip === undefined ? '203.0.113.7' : opts.ip,
    });
  return { clock, deps, metrics, pair };
}

async function attempts(metrics: HubMetrics, result: string): Promise<number> {
  const { values } = await metrics.pairAttempts.get();
  return values.find((v) => v.labels.result === result)?.value ?? 0;
}

/** A 5-digit code that no row holds (so it can't match anything). */
async function freeCode(db: Db): Promise<string> {
  for (;;) {
    const code = String(Math.floor(Math.random() * 100_000)).padStart(5, '0');
    const rows = await db.select().from(pairingCodes).where(eq(pairingCodes.code, code));
    if (rows.length === 0) return code;
  }
}

/** Seeds an active code for a new (or given) user, created at `clock` and valid for `ttlMs`. */
async function seedCode(
  clock: FakeClock,
  opts: { userId?: string; label?: string | null; ttlMs?: number } = {},
) {
  const userId = opts.userId ?? (await seedUser(t.db));
  const code = await freeCode(t.db);
  const row = await insertCodeWithValue(t.db, {
    code,
    userId,
    label: opts.label ?? null,
    now: clock.date(),
    expiresAt: new Date(clock.t + (opts.ttlMs ?? 5 * MIN)),
  });
  if (!row) throw new Error('seedCode: code taken');
  return { ...row, userId };
}

const body = (code: unknown) => JSON.stringify({ code });

describe('pairRateKey', () => {
  it('keys IPv4 by the full address', () => {
    expect(pairRateKey('203.0.113.7')).toBe('203.0.113.7');
    expect(pairRateKey('203.0.113.8')).toBe('203.0.113.8');
  });

  it('keys IPv6 by its /64 prefix, whatever the spelling', () => {
    const key = '2001:db8:1:2::/64';
    expect(pairRateKey('2001:db8:1:2::1')).toBe(key);
    expect(pairRateKey('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe(key);
    expect(pairRateKey('2001:0DB8:0001:0002:0:0:0:9')).toBe(key);
    expect(pairRateKey('2001:db8:1:2::1%eth0')).toBe(key);
    expect(pairRateKey('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64');
    expect(pairRateKey('::1')).toBe('0:0:0:0::/64');
    expect(pairRateKey('fe80::')).toBe('fe80:0:0:0::/64');
    expect(pairRateKey('2001:db8::')).toBe('2001:db8:0:0::/64');
  });

  it('keys an IPv4-mapped IPv6 address as the IPv4 address', () => {
    expect(pairRateKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(pairRateKey('::ffff:cb00:7107')).toBe('203.0.113.7');
    expect(pairRateKey('0:0:0:0:0:ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('keys other embedded-IPv4 forms by their /64', () => {
    expect(pairRateKey('64:ff9b::203.0.113.7')).toBe('64:ff9b:0:0::/64');
    expect(pairRateKey('1:2:3:4:5:6:1.2.3.4')).toBe('1:2:3:4::/64');
  });

  it("uses 'unknown' without an address and the text itself for non-addresses", () => {
    expect(pairRateKey(null)).toBe('unknown');
    expect(pairRateKey(undefined)).toBe('unknown');
    expect(pairRateKey('  ')).toBe('unknown');
    expect(pairRateKey('1:2:3')).toBe('1:2:3');
    expect(pairRateKey('1::2::3')).toBe('1::2::3');
    expect(pairRateKey('::ffff:999.1.1.1')).toBe('::ffff:999.1.1.1');
    expect(pairRateKey('Not-An-IP')).toBe('not-an-ip');
  });
});

describe('outdatedPluginMessage', () => {
  it('is the exact handoff text for 1.5', () => {
    expect(outdatedPluginMessage('1.5')).toBe(OUTDATED_TEXT);
    expect(PAIR_MESSAGES.outdated).toBe(OUTDATED_TEXT);
  });

  it('names the configured minimum', () => {
    expect(outdatedPluginMessage('1.6')).toContain('HA Exporter 1.6 or newer');
    expect(outdatedPluginMessage('1.5.1')).toContain('HA Exporter 1.5.1 or newer');
    expect(outdatedPluginMessage('2')).toContain('HA Exporter 2.0 or newer');
  });

  it('keeps every message within what the plugin shows (200 characters)', () => {
    for (const message of Object.values(PAIR_MESSAGES)) {
      expect(message.length).toBeLessThanOrEqual(200);
    }
  });
});

describe('handlePair: success', () => {
  it('consumes the code, creates the device and answers 200 with a one-time token', async () => {
    const { clock, pair, metrics } = setup();
    const code = await seedCode(clock, { label: 'Desktop PC' });

    const res = await pair(body(code.code), { version: '1.5.2', ip: '198.51.100.1' });

    expect(res.status).toBe(200);
    expect(res.headers).toEqual({ 'Cache-Control': 'no-store' });
    const b = res.body as { ok: boolean; token: string; device_id: string; name: string };
    expect(Object.keys(b).sort()).toEqual(['device_id', 'name', 'ok', 'token']);
    expect(b.ok).toBe(true);
    expect(b.token).toMatch(/^[0-9a-f]{64}$/);
    expect(b.name).toBe('Test Hub');

    const [device] = await t.db.select().from(devices).where(eq(devices.id, b.device_id));
    expect(device).toMatchObject({
      userId: code.userId,
      label: 'Desktop PC',
      tokenHash: sha256Hex(b.token),
      pluginVersion: '1.5.2',
      lastIp: '198.51.100.1',
      revokedAt: null,
      outdatedAt: null,
    });
    expect(device?.createdAt).toEqual(clock.date());

    const [row] = await t.db.select().from(pairingCodes).where(eq(pairingCodes.id, code.id));
    expect(row?.consumedAt).toEqual(clock.date());
    expect(row?.deviceId).toBe(b.device_id);

    expect(await listener.waitFor(1)).toEqual([
      { kind: 'consumed', userId: code.userId, codeId: code.id, deviceId: b.device_id },
    ]);

    const audits = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'device.paired'), eq(auditLog.targetId, b.device_id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: code.userId,
      targetType: 'device',
      meta: { codeId: code.id, pluginVersion: '1.5.2' },
    });
    expect(await attempts(metrics, 'paired')).toBe(1);
  });

  it('caps the connection name at 64 characters', async () => {
    const { clock, pair } = setup({ hubName: 'x'.repeat(80) });
    const code = await seedCode(clock);
    const res = await pair(body(code.code));
    expect(res.status).toBe(200);
    expect((res.body as { name: string }).name).toBe('x'.repeat(64));
  });

  it('accepts a code with leading zeros as a string (PLUGIN-6)', async () => {
    const { clock, pair } = setup();
    const userId = await seedUser(t.db);
    await t.db.delete(pairingCodes).where(eq(pairingCodes.code, '00042'));
    const row = await insertCodeWithValue(t.db, {
      code: '00042',
      userId,
      label: null,
      now: clock.date(),
      expiresAt: new Date(clock.t + MIN),
    });
    expect(row).not.toBeNull();
    const res = await pair(body('00042'));
    expect(res.status).toBe(200);
  });

  it('never logs the code or the token', async () => {
    const { logger, lines } = captureLogger();
    const { clock, pair } = setup({ logger });
    const code = await seedCode(clock);
    const res = await pair(body(code.code));
    await pair(body(code.code)); // invalid now
    const token = (res.body as { token: string }).token;
    const output = lines.join('\n');
    expect(output).toContain('device paired');
    expect(output).not.toContain(token);
    expect(output).not.toContain(sha256Hex(token));
    // Not as a standalone number (uuids are hex, so the digits could occur inside one by chance).
    expect(output).not.toMatch(new RegExp(`(?<![0-9a-f])${code.code}(?![0-9a-f])`));
  });
});

describe('handlePair: invalid codes', () => {
  it('answers 403 when the code was already used', async () => {
    const { clock, pair, metrics } = setup();
    const code = await seedCode(clock);
    expect((await pair(body(code.code))).status).toBe(200);
    const again = await pair(body(code.code));
    expect(again).toEqual({ status: 403, body: { ok: false, error: PAIR_MESSAGES.invalid } });
    expect(await attempts(metrics, 'invalid')).toBe(1);
    const owned = await t.db.select().from(devices).where(eq(devices.userId, code.userId));
    expect(owned).toHaveLength(1);
  });

  it('answers 403 for an expired code and 403 for an unknown one', async () => {
    const { clock, pair } = setup();
    const code = await seedCode(clock, { ttlMs: MIN });
    clock.advance(MIN); // expires_at > now fails exactly at expiry
    expect(await pair(body(code.code))).toEqual({
      status: 403,
      body: { ok: false, error: PAIR_MESSAGES.invalid },
    });
    const [row] = await t.db.select().from(pairingCodes).where(eq(pairingCodes.id, code.id));
    expect(row?.consumedAt).toBeNull();

    expect((await pair(body(await freeCode(t.db)))).status).toBe(403);
  });

  it("answers 403 and leaves the code alone when its creator isn't active", async () => {
    const { clock, pair, metrics } = setup();
    const userId = await seedUser(t.db, { status: 'grace' });
    const code = await seedCode(clock, { userId });

    const res = await pair(body(code.code));

    expect(res).toEqual({ status: 403, body: { ok: false, error: PAIR_MESSAGES.inactive } });
    const [row] = await t.db.select().from(pairingCodes).where(eq(pairingCodes.id, code.id));
    expect(row?.consumedAt).toBeNull();
    expect(await t.db.select().from(devices).where(eq(devices.userId, userId))).toHaveLength(0);
    await listener.flush();
    expect(listener.messages).toEqual([]);
    expect(await attempts(metrics, 'inactive')).toBe(1);
  });

  it('lets exactly one of two concurrent requests with the same code through', async () => {
    const { clock, pair } = setup();
    const code = await seedCode(clock);
    const results = await Promise.all([
      pair(body(code.code), { ip: '198.51.100.20' }),
      pair(body(code.code), { ip: '198.51.100.21' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
    expect(await t.db.select().from(devices).where(eq(devices.userId, code.userId))).toHaveLength(
      1,
    );
  });
});

describe('handlePair: malformed requests', () => {
  const cases: [string, string | null][] = [
    ['no body', null],
    ['an empty body', ''],
    ['invalid JSON', '{"code":'],
    ['JSON null', 'null'],
    ['a JSON string', '"12345"'],
    ['an array', '[{"code":"12345"}]'],
    ['no code', '{}'],
    ['a number code', '{"code":12345}'],
    ['Arabic-Indic digits', body('١٢٣٤٥')],
    ['four digits', body('1234')],
    ['six digits', body('123456')],
    ['surrounding spaces', body(' 12345')],
    ['a trailing newline', body('12345\n')],
    ['letters', body('12a45')],
    ['a null code', '{"code":null}'],
  ];

  it.each(cases)('answers 400 for %s', async (_name, requestBody) => {
    const { pair, metrics } = setup();
    const res = await pair(requestBody);
    expect(res).toEqual({ status: 400, body: { ok: false, error: PAIR_MESSAGES.malformed } });
    expect(await attempts(metrics, 'malformed')).toBe(1);
  });

  it("doesn't count malformed requests towards the lockout", async () => {
    const { clock, pair, deps } = setup();
    for (let i = 0; i < 30; i++) {
      if (i % 10 === 0) clock.advance(10 * MIN);
      await pair('{"code":1}');
    }
    expect(deps.limits.lockout.lockedFor(pairRateKey('203.0.113.7'))).toBe(0);
  });
});

describe('handlePair: version gate', () => {
  it('answers 400, keeps the code and tells the wizard when the plugin is too old', async () => {
    const { clock, pair, metrics } = setup();
    const code = await seedCode(clock);

    const res = await pair(body(code.code), { version: '1.4.9' });

    expect(res).toEqual({ status: 400, body: { ok: false, error: OUTDATED_TEXT } });
    const [row] = await t.db.select().from(pairingCodes).where(eq(pairingCodes.id, code.id));
    expect(row).toMatchObject({
      consumedAt: null,
      deviceId: null,
      lastOutdatedAttemptAt: clock.date(),
      lastOutdatedVersion: '1.4.9',
    });
    expect(await listener.waitFor(1)).toEqual([
      { kind: 'outdated_plugin', userId: code.userId, codeId: code.id, version: '1.4.9' },
    ]);
    expect(await attempts(metrics, 'outdated')).toBe(1);

    // After updating the plugin, the same code still pairs.
    clock.advance(MIN);
    expect((await pair(body(code.code), { version: '1.5' })).status).toBe(200);
  });

  it('treats a missing version header as outdated', async () => {
    const { clock, pair } = setup();
    const code = await seedCode(clock);
    const res = await pair(body(code.code), { version: null });
    expect(res).toEqual({ status: 400, body: { ok: false, error: OUTDATED_TEXT } });
    const [row] = await t.db.select().from(pairingCodes).where(eq(pairingCodes.id, code.id));
    expect(row?.lastOutdatedAttemptAt).toEqual(clock.date());
    expect(row?.lastOutdatedVersion).toBeNull();
    expect(await listener.waitFor(1)).toEqual([
      { kind: 'outdated_plugin', userId: code.userId, codeId: code.id, version: null },
    ]);
  });

  it('answers the same whether or not the code exists', async () => {
    const { clock, pair } = setup();
    const code = await seedCode(clock);
    const withCode = await pair(body(code.code), { version: '1.4' });
    const withoutCode = await pair(body(await freeCode(t.db)), { version: '1.4' });
    expect(withoutCode).toEqual(withCode);
    await listener.flush();
    expect(listener.messages).toHaveLength(1);
  });

  it("doesn't record an attempt on an expired or consumed code", async () => {
    const { clock, pair } = setup();
    const expired = await seedCode(clock, { ttlMs: MIN });
    const consumed = await seedCode(clock);
    expect((await pair(body(consumed.code))).status).toBe(200);
    await listener.waitFor(1); // the 'consumed' notification
    listener.messages.length = 0;
    clock.advance(2 * MIN);

    await pair(body(expired.code), { version: '1.4' });
    await pair(body(consumed.code), { version: '1.4' });

    for (const id of [expired.id, consumed.id]) {
      const [row] = await t.db.select().from(pairingCodes).where(eq(pairingCodes.id, id));
      expect(row?.lastOutdatedAttemptAt).toBeNull();
    }
    await listener.flush();
    expect(listener.messages).toEqual([]);
  });

  it('checks the body before the version', async () => {
    const { pair } = setup();
    expect((await pair('{"code":12345}', { version: '1.0' })).body).toEqual({
      ok: false,
      error: PAIR_MESSAGES.malformed,
    });
  });

  it('names the configured minimum and stores a sanitized version text', async () => {
    const { clock, pair } = setup({ minPluginVersion: '1.6' });
    const code = await seedCode(clock);
    const res = await pair(body(code.code), { version: ` 1.5-SNAPSHOT${'x'.repeat(40)} ` });
    expect(res.body).toEqual({ ok: false, error: outdatedPluginMessage('1.6') });
    const [row] = await t.db.select().from(pairingCodes).where(eq(pairingCodes.id, code.id));
    expect(row?.lastOutdatedVersion).toBe(`1.5-SNAPSHOT${'x'.repeat(20)}`);
  });
});

describe('handlePair: rate limits', () => {
  it('allows 10 attempts per client per 10 minutes, then 429 with an integer Retry-After', async () => {
    const { clock, pair, metrics } = setup();
    for (let i = 0; i < 10; i++) {
      expect((await pair(null)).status).toBe(400);
      clock.advance(1_000);
    }
    const res = await pair(null);
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ ok: false, error: PAIR_MESSAGES.rateLimited });
    // The first attempt stops counting 10 min after it was made: 590 s from now.
    expect(res.headers).toEqual({ 'Retry-After': '590' });
    expect(await attempts(metrics, 'rate_limited_ip')).toBe(1);

    // Another client is unaffected; the same client may try again once the window moved.
    expect((await pair(null, { ip: '203.0.113.99' })).status).toBe(400);
    clock.advance(590_000);
    expect((await pair(null)).status).toBe(400);
  });

  it('limits a whole IPv6 /64 as one client', async () => {
    const { pair } = setup();
    for (let i = 1; i <= 10; i++) {
      expect((await pair(null, { ip: `2001:db8:1:2::${i.toString(16)}` })).status).toBe(400);
    }
    expect((await pair(null, { ip: '2001:db8:1:2:abcd::1' })).status).toBe(429);
    expect((await pair(null, { ip: '2001:db8:1:3::1' })).status).toBe(400);
  });

  it('shares one limit between all clients without a known address', async () => {
    const { pair } = setup();
    for (let i = 0; i < 10; i++) await pair(null, { ip: null });
    expect((await pair(null, { ip: null })).status).toBe(429);
  });

  it('allows 60 attempts per minute over all clients', async () => {
    const { clock, pair, metrics } = setup();
    for (let i = 0; i < 60; i++) {
      expect((await pair(null, { ip: `192.0.2.${i}` })).status).toBe(400);
    }
    const res = await pair(null, { ip: '192.0.2.200' });
    expect(res.status).toBe(429);
    expect(res.headers?.['Retry-After']).toMatch(/^[1-9][0-9]*$/);
    expect(await attempts(metrics, 'rate_limited_global')).toBe(1);
    clock.advance(MIN);
    expect((await pair(null, { ip: '192.0.2.200' })).status).toBe(400);
  });

  it('locks a client out for 15 minutes after 20 invalid codes within an hour', async () => {
    const { clock, pair, metrics } = setup();
    const unknown = await freeCode(t.db);
    for (let i = 0; i < 20; i++) {
      if (i % 10 === 0) clock.advance(10 * MIN); // stay under the per-client limit
      expect((await pair(body(unknown))).status).toBe(403);
    }
    const valid = await seedCode(clock);
    const res = await pair(body(valid.code));
    expect(res).toEqual({
      status: 429,
      body: { ok: false, error: PAIR_MESSAGES.rateLimited },
      headers: { 'Retry-After': '900' },
    });
    expect(await attempts(metrics, 'locked_out')).toBe(1);
    // Another client is not locked out.
    expect((await pair(body(valid.code), { ip: '198.51.100.99' })).status).toBe(200);

    clock.advance(15 * MIN);
    expect((await pair(body(unknown))).status).toBe(403);
  });

  it("doesn't clear failures on a successful pairing", async () => {
    const { clock, pair } = setup();
    const unknown = await freeCode(t.db);
    for (let i = 0; i < 19; i++) {
      if (i % 9 === 0) clock.advance(10 * MIN);
      expect((await pair(body(unknown))).status).toBe(403);
    }
    const valid = await seedCode(clock);
    expect((await pair(body(valid.code))).status).toBe(200);
    expect((await pair(body(unknown))).status).toBe(403); // the 20th failure
    expect((await pair(body(unknown))).status).toBe(429);
  });
});

describe('handlePair: server errors', () => {
  it('answers 503 with Retry-After 30 when the database is unreachable', async () => {
    const down = createDb('postgres://hub:hub@127.0.0.1:1/nowhere', { max: 1 });
    try {
      const { logger, lines } = captureLogger();
      const { pair, metrics } = setup({ db: down.db, logger });
      const res = await pair(body('12345'));
      expect(res).toEqual({
        status: 503,
        body: { ok: false, error: PAIR_MESSAGES.unavailable },
        headers: { 'Retry-After': '30' },
      });
      expect(await attempts(metrics, 'unavailable')).toBe(1);
      expect(lines.join('\n')).not.toContain('12345');
    } finally {
      await down.pool.end();
    }
  });

  it('still tells an outdated plugin to update when the database is unreachable', async () => {
    const down = createDb('postgres://hub:hub@127.0.0.1:1/nowhere', { max: 1 });
    try {
      const { pair } = setup({ db: down.db });
      expect(await pair(body('12345'), { version: '1.4' })).toEqual({
        status: 400,
        body: { ok: false, error: OUTDATED_TEXT },
      });
    } finally {
      await down.pool.end();
    }
  });

  it('answers 503 when the code row stays locked past the lock timeout', async () => {
    const { clock, pair } = setup();
    const code = await seedCode(clock);
    const blocker = new pg.Client({ connectionString: t.url });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM pairing_codes WHERE id = $1 FOR UPDATE', [code.id]);
      const res = await pair(body(code.code));
      expect(res.status).toBe(503);
      expect(res.headers).toEqual({ 'Retry-After': '30' });
    } finally {
      await blocker.query('ROLLBACK');
      await blocker.end();
    }
    // Nothing was consumed: the code still pairs.
    expect((await pair(body(code.code))).status).toBe(200);
  });

  it('answers 500 with a JSON error for an unexpected failure', async () => {
    const { pair, metrics } = setup({ minPluginVersion: 'not-a-version' });
    const res = await pair(body('12345'));
    expect(res).toEqual({ status: 500, body: { ok: false, error: PAIR_MESSAGES.failed } });
    expect(await attempts(metrics, 'error')).toBe(1);
  });
});
