import { accountLinks, pairingCodes } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from '../logger';
import { createTestMetrics } from '../metrics';
import {
  MAX_ACTIVE_PAIRING_CODES,
  createPairingCode,
  getDeviceFirstData,
  getPairingCodeStatus,
  insertCodeWithValue,
} from './codes';
import { createPairLimits } from './limits';
import { handlePair } from './pair';
import { FakeClock, linkDeviceAccount, seedAccount, seedDevice, seedUser } from './test-support';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase('pairingcodes');
});

afterAll(async () => {
  await t.drop();
});

const MIN = 60_000;
const TTL = 300;

async function activeCodes(userId: string, now: Date) {
  return t.db
    .select()
    .from(pairingCodes)
    .where(
      and(
        eq(pairingCodes.userId, userId),
        isNull(pairingCodes.consumedAt),
        gt(pairingCodes.expiresAt, now),
      ),
    );
}

/** A code no row holds. */
async function freeCode(): Promise<string> {
  for (;;) {
    const code = String(Math.floor(Math.random() * 100_000)).padStart(5, '0');
    const rows = await t.db.select().from(pairingCodes).where(eq(pairingCodes.code, code));
    if (rows.length === 0) return code;
  }
}

describe('createPairingCode', () => {
  it('creates a 5-digit code valid for the TTL', async () => {
    const clock = new FakeClock();
    const userId = await seedUser(t.db);
    const created = await createPairingCode(t.db, {
      userId,
      label: 'Laptop',
      ttlSeconds: TTL,
      now: clock.date(),
    });
    expect(created.code).toMatch(/^[0-9]{5}$/);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.expiresAt).toEqual(new Date(clock.t + TTL * 1000));
    const [row] = await t.db.select().from(pairingCodes).where(eq(pairingCodes.id, created.id));
    expect(row).toMatchObject({
      code: created.code,
      userId,
      label: 'Laptop',
      createdAt: clock.date(),
      consumedAt: null,
      deviceId: null,
    });
  });

  it('normalizes the label', async () => {
    const clock = new FakeClock();
    const userId = await seedUser(t.db);
    const label = async (value: string | null | undefined) => {
      const { id } = await createPairingCode(t.db, {
        userId,
        label: value,
        ttlSeconds: TTL,
        now: clock.date(),
      });
      const [row] = await t.db.select().from(pairingCodes).where(eq(pairingCodes.id, id));
      return row?.label;
    };
    expect(await label('  Desktop PC \n')).toBe('Desktop PC');
    expect(await label('   ')).toBeNull();
    expect(await label(undefined)).toBeNull();
    expect(await label('a'.repeat(100))).toBe('a'.repeat(64));
    expect(await label(`${'b'.repeat(63)}😀😀`)).toBe(`${'b'.repeat(63)}😀`);
  });

  it('keeps at most 3 active codes, expiring the oldest', async () => {
    const clock = new FakeClock();
    const userId = await seedUser(t.db);
    const created = [];
    for (let i = 0; i < 5; i++) {
      created.push(await createPairingCode(t.db, { userId, ttlSeconds: TTL, now: clock.date() }));
      clock.advance(1_000);
      expect((await activeCodes(userId, clock.date())).length).toBe(Math.min(i + 1, 3));
    }
    const active = await activeCodes(userId, clock.date());
    expect(active.map((r) => r.id).sort()).toEqual(
      created
        .slice(2)
        .map((c) => c.id)
        .sort(),
    );
    // The retired ones expired at the moment the newer code was created.
    const [first] = await t.db
      .select()
      .from(pairingCodes)
      .where(eq(pairingCodes.id, created[0]!.id));
    expect(first?.expiresAt).toEqual(new Date(created[3]!.expiresAt.getTime() - TTL * 1000));
    expect(MAX_ACTIVE_PAIRING_CODES).toBe(3);
  });

  it("doesn't count consumed or expired codes, nor other users' codes", async () => {
    const clock = new FakeClock();
    const userId = await seedUser(t.db);
    const other = await seedUser(t.db);
    const consumed = await createPairingCode(t.db, { userId, ttlSeconds: TTL, now: clock.date() });
    await t.db
      .update(pairingCodes)
      .set({ consumedAt: clock.date() })
      .where(eq(pairingCodes.id, consumed.id));
    await createPairingCode(t.db, { userId, ttlSeconds: 60, now: clock.date() });
    clock.advance(2 * MIN); // that one has expired now
    for (let i = 0; i < 3; i++) {
      await createPairingCode(t.db, { userId: other, ttlSeconds: TTL, now: clock.date() });
    }
    const kept = [];
    for (let i = 0; i < 3; i++) {
      kept.push(await createPairingCode(t.db, { userId, ttlSeconds: TTL, now: clock.date() }));
    }
    const active = await activeCodes(userId, clock.date());
    expect(active.map((r) => r.id).sort()).toEqual(kept.map((c) => c.id).sort());
    expect(await activeCodes(other, clock.date())).toHaveLength(3);
    const [consumedRow] = await t.db
      .select()
      .from(pairingCodes)
      .where(eq(pairingCodes.id, consumed.id));
    expect(consumedRow?.expiresAt).toEqual(new Date(clock.t - 2 * MIN + TTL * 1000));
  });

  it('keeps the limit under concurrent requests', async () => {
    const clock = new FakeClock();
    const userId = await seedUser(t.db);
    await Promise.all(
      Array.from({ length: 6 }, () =>
        createPairingCode(t.db, { userId, ttlSeconds: TTL, now: clock.date() }),
      ),
    );
    expect(await activeCodes(userId, clock.date())).toHaveLength(3);
  });

  it('rejects a non-positive TTL', async () => {
    const userId = await seedUser(t.db);
    await expect(createPairingCode(t.db, { userId, ttlSeconds: 0 })).rejects.toThrow(RangeError);
    await expect(createPairingCode(t.db, { userId, ttlSeconds: Number.NaN })).rejects.toThrow(
      RangeError,
    );
  });
});

describe('insertCodeWithValue (one draw of createPairingCode)', () => {
  it("returns null when the code is active for someone, so it's drawn again", async () => {
    const clock = new FakeClock();
    const alice = await seedUser(t.db);
    const bob = await seedUser(t.db);
    const code = await freeCode();
    const values = { code, label: null, now: clock.date(), expiresAt: new Date(clock.t + MIN) };
    expect(await insertCodeWithValue(t.db, { ...values, userId: alice })).not.toBeNull();
    expect(await insertCodeWithValue(t.db, { ...values, userId: bob })).toBeNull();
    const rows = await t.db.select().from(pairingCodes).where(eq(pairingCodes.code, code));
    expect(rows.map((r) => r.userId)).toEqual([alice]);
  });

  it('reuses the code of an expired, unconsumed row by deleting it', async () => {
    const clock = new FakeClock();
    const alice = await seedUser(t.db);
    const bob = await seedUser(t.db);
    const code = await freeCode();
    const old = await insertCodeWithValue(t.db, {
      code,
      userId: alice,
      label: null,
      now: clock.date(),
      expiresAt: new Date(clock.t + MIN),
    });
    clock.advance(MIN); // exactly expired
    const reused = await insertCodeWithValue(t.db, {
      code,
      userId: bob,
      label: 'x',
      now: clock.date(),
      expiresAt: new Date(clock.t + MIN),
    });
    expect(reused).toMatchObject({ code });
    const rows = await t.db.select().from(pairingCodes).where(eq(pairingCodes.code, code));
    expect(rows.map((r) => r.id)).toEqual([reused!.id]);
    expect(rows[0]?.id).not.toBe(old!.id);
  });

  it('keeps consumed rows with the same code (history) and still inserts', async () => {
    const clock = new FakeClock();
    const alice = await seedUser(t.db);
    const code = await freeCode();
    const values = { code, userId: alice, label: null, now: clock.date() };
    const first = await insertCodeWithValue(t.db, {
      ...values,
      expiresAt: new Date(clock.t + MIN),
    });
    await t.db
      .update(pairingCodes)
      .set({ consumedAt: clock.date() })
      .where(eq(pairingCodes.id, first!.id));
    const second = await insertCodeWithValue(t.db, {
      ...values,
      expiresAt: new Date(clock.t + MIN),
    });
    expect(second).not.toBeNull();
    const rows = await t.db.select().from(pairingCodes).where(eq(pairingCodes.code, code));
    expect(rows).toHaveLength(2);
  });

  it('rejects anything but 5 ASCII digits', async () => {
    const userId = await seedUser(t.db);
    const values = { userId, label: null, now: new Date(), expiresAt: new Date() };
    await expect(insertCodeWithValue(t.db, { ...values, code: '1234' })).rejects.toThrow(
      RangeError,
    );
    await expect(insertCodeWithValue(t.db, { ...values, code: '١٢٣٤٥' })).rejects.toThrow(
      RangeError,
    );
  });
});

describe('getPairingCodeStatus', () => {
  it('reports active, expired and consumed codes of the user', async () => {
    const clock = new FakeClock();
    const userId = await seedUser(t.db);
    const created = await createPairingCode(t.db, { userId, ttlSeconds: 60, now: clock.date() });

    expect(
      await getPairingCodeStatus(t.db, { userId, codeId: created.id, now: clock.date() }),
    ).toEqual({
      id: created.id,
      code: created.code,
      status: 'active',
      expiresAt: created.expiresAt,
      deviceId: null,
      outdatedAttemptAt: null,
      outdatedVersion: null,
    });

    const later = new Date(clock.t + MIN);
    expect(
      (await getPairingCodeStatus(t.db, { userId, codeId: created.id, now: later }))?.status,
    ).toBe('expired');
  });

  it('shows an outdated attempt, then the device once consumed', async () => {
    const clock = new FakeClock();
    const userId = await seedUser(t.db);
    const created = await createPairingCode(t.db, { userId, ttlSeconds: TTL, now: clock.date() });
    const deps = {
      db: t.db,
      minPluginVersion: '1.5',
      hubName: 'Hub',
      limits: createPairLimits({ clock }),
      logger: silentLogger(),
      metrics: createTestMetrics(),
      now: () => clock.date(),
    };
    const body = JSON.stringify({ code: created.code });

    await handlePair(deps, { body, versionHeader: '1.4', ip: null });
    expect(
      await getPairingCodeStatus(t.db, { userId, codeId: created.id, now: clock.date() }),
    ).toMatchObject({
      status: 'active',
      outdatedAttemptAt: clock.date(),
      outdatedVersion: '1.4',
      deviceId: null,
    });

    const res = await handlePair(deps, { body, versionHeader: '1.5', ip: null });
    const deviceId = (res.body as { device_id: string }).device_id;
    // Consumed stays consumed after the code's expiry.
    const later = new Date(clock.t + 2 * TTL * 1000);
    expect(
      await getPairingCodeStatus(t.db, { userId, codeId: created.id, now: later }),
    ).toMatchObject({ status: 'consumed', deviceId });
  });

  it("returns null for another user's code, an unknown id and a malformed id", async () => {
    const userId = await seedUser(t.db);
    const other = await seedUser(t.db);
    const created = await createPairingCode(t.db, { userId, ttlSeconds: TTL });
    expect(await getPairingCodeStatus(t.db, { userId: other, codeId: created.id })).toBeNull();
    expect(
      await getPairingCodeStatus(t.db, {
        userId,
        codeId: '01900000-0000-7000-8000-000000000000',
      }),
    ).toBeNull();
    expect(await getPairingCodeStatus(t.db, { userId, codeId: 'not-a-uuid' })).toBeNull();
  });
});

describe('getDeviceFirstData', () => {
  it('returns null until the device reported an account', async () => {
    const userId = await seedUser(t.db);
    const deviceId = await seedDevice(t.db, userId);
    expect(await getDeviceFirstData(t.db, { userId, deviceId })).toBeNull();
  });

  it('returns the first account the device reported, as owner', async () => {
    const clock = new FakeClock();
    const userId = await seedUser(t.db, { name: 'Alice' });
    const deviceId = await seedDevice(t.db, userId);
    const later = await seedAccount(t.db, { name: 'Second', ownerUserId: userId });
    const first = await seedAccount(t.db, { name: 'Zezima', ownerUserId: userId, accountType: 1 });
    await linkDeviceAccount(t.db, deviceId, later.id, { firstSeen: new Date(clock.t + MIN) });
    await linkDeviceAccount(t.db, deviceId, first.id, {
      firstSeen: clock.date(),
      lastSeen: new Date(clock.t + 2 * MIN),
    });
    await t.db.insert(accountLinks).values({ accountId: first.id, userId, role: 'owner' });

    expect(await getDeviceFirstData(t.db, { userId, deviceId })).toEqual({
      account: { publicId: first.publicId, name: 'Zezima', accountType: 1 },
      role: 'owner',
      ownerName: 'Alice',
    });
  });

  it("names the owner when the user is a contributor, and null when there's none", async () => {
    const clock = new FakeClock();
    const owner = await seedUser(t.db, { name: 'Owner Olga' });
    const userId = await seedUser(t.db);
    const deviceId = await seedDevice(t.db, userId);
    const shared = await seedAccount(t.db, { name: 'Shared', ownerUserId: owner });
    await linkDeviceAccount(t.db, deviceId, shared.id, { firstSeen: clock.date() });
    await t.db.insert(accountLinks).values([
      { accountId: shared.id, userId: owner, role: 'owner' },
      { accountId: shared.id, userId, role: 'contributor' },
    ]);
    expect(await getDeviceFirstData(t.db, { userId, deviceId })).toEqual({
      account: { publicId: shared.publicId, name: 'Shared', accountType: null },
      role: 'contributor',
      ownerName: 'Owner Olga',
    });

    const otherDevice = await seedDevice(t.db, userId);
    const orphan = await seedAccount(t.db, { name: 'Orphan', ownerUserId: null });
    await linkDeviceAccount(t.db, otherDevice, orphan.id, { firstSeen: clock.date() });
    expect(await getDeviceFirstData(t.db, { userId, deviceId: otherDevice })).toMatchObject({
      role: 'contributor',
      ownerName: null,
    });
  });

  it("returns null for another user's device and a malformed id", async () => {
    const clock = new FakeClock();
    const userId = await seedUser(t.db);
    const other = await seedUser(t.db);
    const deviceId = await seedDevice(t.db, userId);
    const account = await seedAccount(t.db, { name: 'Mine', ownerUserId: userId });
    await linkDeviceAccount(t.db, deviceId, account.id, { firstSeen: clock.date() });
    expect(await getDeviceFirstData(t.db, { userId: other, deviceId })).toBeNull();
    expect(await getDeviceFirstData(t.db, { userId, deviceId: 'nope' })).toBeNull();
  });
});
