import { randomUUID } from 'node:crypto';
import { auditLog, rawPayloads } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedUser } from '../offboarding/test-support';
import { getRawPayload, listRawPayloads, RAW_PAYLOAD_PAGE_MAX } from './raw-payloads';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase('rawpayloads');
});

afterAll(async () => {
  await t.drop();
});

const NOW = new Date('2026-09-28T12:00:00Z');
const SEC = 1000;
const deviceA = randomUUID();
const deviceB = randomUUID();

interface Seeded {
  id: string;
  receivedAt: Date;
  body: string;
}

async function payload(
  secAgo: number,
  opts: {
    deviceId?: string;
    status?: number | null;
    body?: string;
    meta?: unknown;
    id?: string;
  } = {},
): Promise<Seeded> {
  const receivedAt = new Date(NOW.getTime() - secAgo * SEC);
  const body = opts.body ?? '{"player":{}}';
  const [row] = await t.db
    .insert(rawPayloads)
    .values({
      ...(opts.id ? { id: opts.id } : {}),
      receivedAt,
      deviceId: opts.deviceId ?? deviceA,
      accountId: 7,
      status: opts.status === undefined ? 200 : opts.status,
      pluginVersion: '1.5',
      meta: opts.meta ?? null,
      body,
    })
    .returning({ id: rawPayloads.id, receivedAt: rawPayloads.receivedAt });
  if (!row) throw new Error('no row');
  return { ...row, body };
}

describe('listRawPayloads and getRawPayload', () => {
  const rows: Record<string, Seeded> = {};

  beforeAll(async () => {
    rows.newest = await payload(1, { body: '{"name":"Zezima ☃"}', meta: { inserted: 1, ms: 4 } });
    rows.pending = await payload(2, { status: null });
    rows.bad = await payload(3, { status: 400, deviceId: deviceB, body: 'not json' });
    // Two rows received at the same instant: the id orders them.
    rows.tieLow = await payload(4, { id: '01920000-0000-7000-8000-000000000001' });
    rows.tieHigh = await payload(4, { id: '01920000-0000-7000-8000-000000000002' });
    rows.oldest = await payload(5, { deviceId: deviceB });
  });

  it('lists newest first without bodies, with their size in bytes', async () => {
    const list = await listRawPayloads(t.db, { limit: 50 });
    expect(list.map((r) => r.id)).toEqual([
      rows.newest!.id,
      rows.pending!.id,
      rows.bad!.id,
      rows.tieHigh!.id,
      rows.tieLow!.id,
      rows.oldest!.id,
    ]);
    expect(list[0]).toEqual({
      id: rows.newest!.id,
      receivedAt: rows.newest!.receivedAt,
      deviceId: deviceA,
      accountId: 7,
      status: 200,
      pluginVersion: '1.5',
      meta: { inserted: 1, ms: 4 },
      size: Buffer.byteLength('{"name":"Zezima ☃"}'),
    });
    expect(list[0]).not.toHaveProperty('body');
  });

  it('filters by device and status', async () => {
    const byDevice = await listRawPayloads(t.db, { deviceId: deviceB, limit: 50 });
    expect(byDevice.map((r) => r.id)).toEqual([rows.bad!.id, rows.oldest!.id]);
    const bad = await listRawPayloads(t.db, { status: 400, limit: 50 });
    expect(bad.map((r) => r.id)).toEqual([rows.bad!.id]);
    const pending = await listRawPayloads(t.db, { status: 'pending', limit: 50 });
    expect(pending.map((r) => r.id)).toEqual([rows.pending!.id]);
    expect(await listRawPayloads(t.db, { deviceId: "' or 1=1 --", limit: 50 })).toEqual([]);
    expect(await listRawPayloads(t.db, { status: 1e9, limit: 50 })).toEqual([]);
    expect(await listRawPayloads(t.db, { status: 1.5, limit: 50 })).toEqual([]);
  });

  it('pages with a (receivedAt, id) cursor across equal timestamps', async () => {
    const seen: string[] = [];
    let before: { receivedAt: Date; id: string } | undefined;
    for (;;) {
      const page = await listRawPayloads(t.db, { limit: 2, before });
      if (page.length === 0) break;
      seen.push(...page.map((r) => r.id));
      const last = page.at(-1)!;
      before = { receivedAt: last.receivedAt, id: last.id };
    }
    const all = await listRawPayloads(t.db, { limit: 50 });
    expect(seen).toEqual(all.map((r) => r.id));

    const afterTie = await listRawPayloads(t.db, {
      limit: 50,
      before: { receivedAt: rows.tieHigh!.receivedAt, id: rows.tieHigh!.id },
    });
    expect(afterTie.map((r) => r.id)).toEqual([rows.tieLow!.id, rows.oldest!.id]);
  });

  it('clamps the page size', async () => {
    expect(await listRawPayloads(t.db, { limit: 0 })).toHaveLength(1);
    expect(await listRawPayloads(t.db, { limit: -5 })).toHaveLength(1);
    expect(await listRawPayloads(t.db, { limit: Number.NaN })).toHaveLength(6);
  });

  it('answers null, and audits nothing, for a body that does not exist', async () => {
    const actorUserId = await seedUser(t.db, { isAdmin: true });
    const r = rows.bad!;
    for (const miss of [
      { id: r.id, receivedAt: new Date(r.receivedAt.getTime() + 1) },
      { id: 'nope', receivedAt: r.receivedAt },
      { id: r.id, receivedAt: new Date(Number.NaN) },
    ]) {
      expect(await getRawPayload(t.db, { ...miss, actorUserId })).toBeNull();
    }
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('returns one body by id and receive time, and audits the view', async () => {
    const adminId = await seedUser(t.db, { isAdmin: true });
    const r = rows.newest!;
    const body = await getRawPayload(t.db, {
      id: r.id,
      receivedAt: r.receivedAt,
      actorUserId: adminId,
    });
    expect(body).toBe(r.body);
    const entries = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'raw_payload.viewed'));
    expect(entries).toEqual([
      expect.objectContaining({
        actorUserId: adminId,
        targetType: 'raw_payload',
        targetId: r.id,
        meta: { deviceId: deviceA, receivedAt: r.receivedAt.toISOString() },
      }),
    ]);
    // The body comes back as stored, valid JSON or not; that view is audited like any other.
    const bad = rows.bad!;
    expect(
      await getRawPayload(t.db, { id: bad.id, receivedAt: bad.receivedAt, actorUserId: adminId }),
    ).toBe('not json');
    expect(
      await t.db.select().from(auditLog).where(eq(auditLog.action, 'raw_payload.viewed')),
    ).toHaveLength(2);
  });
});

describe('listRawPayloads limits', () => {
  it('caps a page at RAW_PAYLOAD_PAGE_MAX rows', async () => {
    await t.db.execute(sql`
      INSERT INTO raw_payloads (received_at, device_id, status, body)
      SELECT ${NOW.toISOString()}::timestamptz - make_interval(secs => 100 + g), ${deviceA}::uuid, 200, '{}'
      FROM generate_series(1, ${RAW_PAYLOAD_PAGE_MAX + 1}) AS g`);
    expect(await listRawPayloads(t.db, { limit: 100_000 })).toHaveLength(RAW_PAYLOAD_PAGE_MAX);
  });
});

describe('listRawPayloads cursor validation', () => {
  it('refuses an unparseable cursor as invalid input instead of throwing a RangeError or a database error', async () => {
    const bad = new Date('not a date');
    await expect(
      listRawPayloads(t.db, { limit: 10, before: { receivedAt: bad, id: randomUUID() } }),
    ).rejects.toMatchObject({ name: 'AdminError', code: 'invalid' });
    await expect(
      listRawPayloads(t.db, { limit: 10, before: { receivedAt: NOW, id: 'not-a-uuid' } }),
    ).rejects.toMatchObject({ name: 'AdminError', code: 'invalid' });
  });
});
