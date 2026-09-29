import { auditLog, devices } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FakeClock,
  linkDeviceAccount,
  seedAccount,
  seedDevice,
  seedUser,
} from '../pairing/test-support';
import { listAllDevices, listDevices, renameDevice, revokeDevice } from './devices';
import { DEVICE_LABEL_MAX, isUuid, normalizeDeviceLabel } from './util';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase('devices');
});

afterAll(async () => {
  await t.drop();
});

const MIN = 60_000;

async function revokeAudits(deviceId: string) {
  return t.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'device.revoked'), eq(auditLog.targetId, deviceId)));
}

describe('normalizeDeviceLabel', () => {
  it('trims, strips control characters and caps at 64 code points', () => {
    expect(normalizeDeviceLabel('  Desktop PC  ')).toBe('Desktop PC');
    expect(normalizeDeviceLabel('Game\tPC\u0000')).toBe('Game PC');
    expect(normalizeDeviceLabel('')).toBeNull();
    expect(normalizeDeviceLabel(' \n ')).toBeNull();
    expect(normalizeDeviceLabel(null)).toBeNull();
    expect(normalizeDeviceLabel(undefined)).toBeNull();
    expect(normalizeDeviceLabel('x'.repeat(65))).toHaveLength(DEVICE_LABEL_MAX);
    expect(Array.from(normalizeDeviceLabel('😀'.repeat(70)) ?? '')).toHaveLength(64);
    expect(normalizeDeviceLabel(`${'a'.repeat(63)} b`)).toBe('a'.repeat(63));
  });
});

describe('isUuid', () => {
  it('accepts canonical uuids only', () => {
    expect(isUuid('01900000-0000-7000-8000-000000000000')).toBe(true);
    expect(isUuid('01900000-0000-7000-8000-00000000000')).toBe(false);
    expect(isUuid("1' or 1=1")).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
});

describe('listDevices', () => {
  it("lists the user's devices newest first with status and reported accounts", async () => {
    const clock = new FakeClock();
    const userId = await seedUser(t.db);
    const other = await seedUser(t.db);
    const oldest = await seedDevice(t.db, userId, {
      label: 'Old laptop',
      pluginVersion: '1.5',
      createdAt: clock.date(),
      revokedAt: new Date(clock.t + MIN),
      revokedReason: 'user',
      outdatedAt: new Date(clock.t + MIN), // revoked wins
    });
    const outdated = await seedDevice(t.db, userId, {
      pluginVersion: '1.4',
      createdAt: new Date(clock.t + MIN),
      outdatedAt: new Date(clock.t + 2 * MIN),
    });
    const newest = await seedDevice(t.db, userId, {
      label: 'Desktop',
      pluginVersion: '1.5.1',
      createdAt: new Date(clock.t + 2 * MIN),
      lastSeenAt: new Date(clock.t + 5 * MIN),
      firstDataAt: new Date(clock.t + 3 * MIN),
    });
    await seedDevice(t.db, other, { createdAt: new Date(clock.t + 10 * MIN) });

    const main = await seedAccount(t.db, { name: 'Zezima', ownerUserId: userId });
    const alt = await seedAccount(t.db, { name: 'Alt', ownerUserId: userId });
    await linkDeviceAccount(t.db, newest, main.id, {
      firstSeen: new Date(clock.t + 3 * MIN),
      lastSeen: new Date(clock.t + 4 * MIN),
    });
    await linkDeviceAccount(t.db, newest, alt.id, {
      firstSeen: new Date(clock.t + 3 * MIN),
      lastSeen: new Date(clock.t + 5 * MIN),
    });

    const list = await listDevices(t.db, userId);

    expect(list.map((d) => d.id)).toEqual([newest, outdated, oldest]);
    expect(list.map((d) => d.status)).toEqual(['active', 'outdated', 'revoked']);
    expect(list[0]).toEqual({
      id: newest,
      label: 'Desktop',
      pluginVersion: '1.5.1',
      status: 'active',
      createdAt: new Date(clock.t + 2 * MIN),
      lastSeenAt: new Date(clock.t + 5 * MIN),
      firstDataAt: new Date(clock.t + 3 * MIN),
      revokedAt: null,
      revokedReason: null,
      accounts: [
        { publicId: alt.publicId, name: 'Alt', lastSeen: new Date(clock.t + 5 * MIN) },
        { publicId: main.publicId, name: 'Zezima', lastSeen: new Date(clock.t + 4 * MIN) },
      ],
    });
    expect(list[2]).toMatchObject({
      label: 'Old laptop',
      revokedAt: new Date(clock.t + MIN),
      revokedReason: 'user',
      accounts: [],
    });
    expect(list[0]).not.toHaveProperty('outdatedAt');
  });

  it('returns an empty list for a user without devices', async () => {
    expect(await listDevices(t.db, await seedUser(t.db))).toEqual([]);
  });
});

describe('listAllDevices', () => {
  it("lists every user's devices, revoked and outdated included, with their user", async () => {
    const alice = await seedUser(t.db, { name: 'Alice' });
    const bob = await seedUser(t.db, { name: 'Bob' });
    const a = await seedDevice(t.db, alice, { createdAt: new Date('2030-01-01T00:00:00Z') });
    const b = await seedDevice(t.db, bob, {
      createdAt: new Date('2030-01-02T00:00:00Z'),
      revokedAt: new Date('2030-01-03T00:00:00Z'),
      revokedReason: 'admin',
    });
    const c = await seedDevice(t.db, bob, {
      createdAt: new Date('2030-01-03T00:00:00Z'),
      outdatedAt: new Date('2030-01-03T00:00:00Z'),
    });

    const all = await listAllDevices(t.db);

    const ours = all.filter((d) => [a, b, c].includes(d.id));
    expect(ours.map((d) => [d.id, d.status, d.user])).toEqual([
      [c, 'outdated', { id: bob, name: 'Bob' }],
      [b, 'revoked', { id: bob, name: 'Bob' }],
      [a, 'active', { id: alice, name: 'Alice' }],
    ]);
    // Newest first over everything.
    const times = all.map((d) => d.createdAt.getTime());
    expect(times).toEqual([...times].sort((x, y) => y - x));
  });
});

describe('renameDevice', () => {
  it("renames the user's own device with a normalized label", async () => {
    const userId = await seedUser(t.db);
    const deviceId = await seedDevice(t.db, userId, { label: 'old' });

    expect(await renameDevice(t.db, { userId, deviceId, label: `  ${'n'.repeat(70)} ` })).toBe(
      true,
    );
    let [row] = await t.db.select().from(devices).where(eq(devices.id, deviceId));
    expect(row?.label).toBe('n'.repeat(64));

    expect(await renameDevice(t.db, { userId, deviceId, label: '   ' })).toBe(true);
    [row] = await t.db.select().from(devices).where(eq(devices.id, deviceId));
    expect(row?.label).toBeNull();

    expect(await renameDevice(t.db, { userId, deviceId, label: null })).toBe(true);
  });

  it("doesn't rename other users' devices, unknown ids or malformed ids", async () => {
    const userId = await seedUser(t.db);
    const other = await seedUser(t.db);
    const deviceId = await seedDevice(t.db, other, { label: 'theirs' });

    expect(await renameDevice(t.db, { userId, deviceId, label: 'mine now' })).toBe(false);
    expect(
      await renameDevice(t.db, {
        userId,
        deviceId: '01900000-0000-7000-8000-000000000000',
        label: 'x',
      }),
    ).toBe(false);
    expect(await renameDevice(t.db, { userId, deviceId: 'abc', label: 'x' })).toBe(false);
    const [row] = await t.db.select().from(devices).where(eq(devices.id, deviceId));
    expect(row?.label).toBe('theirs');
  });
});

describe('revokeDevice', () => {
  it('revokes an own device once, idempotently, with one audit entry', async () => {
    const clock = new FakeClock();
    const userId = await seedUser(t.db);
    const deviceId = await seedDevice(t.db, userId);

    expect(
      await revokeDevice(t.db, {
        deviceId,
        actorUserId: userId,
        reason: 'user',
        now: clock.date(),
      }),
    ).toBe(true);
    const [row] = await t.db.select().from(devices).where(eq(devices.id, deviceId));
    expect(row).toMatchObject({ revokedAt: clock.date(), revokedReason: 'user' });

    // Again, later and with another reason: still true, first revoke kept.
    clock.advance(MIN);
    expect(
      await revokeDevice(t.db, {
        deviceId,
        actorUserId: userId,
        reason: 'offboarding',
        now: clock.date(),
      }),
    ).toBe(true);
    const [again] = await t.db.select().from(devices).where(eq(devices.id, deviceId));
    expect(again).toMatchObject({ revokedAt: row?.revokedAt, revokedReason: 'user' });

    const audits = await revokeAudits(deviceId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: userId,
      targetType: 'device',
      meta: { reason: 'user', ownerUserId: userId, asAdmin: false },
    });
  });

  it("refuses another user's device unless acting as admin", async () => {
    const owner = await seedUser(t.db);
    const admin = await seedUser(t.db, { isAdmin: true });
    const deviceId = await seedDevice(t.db, owner);

    expect(await revokeDevice(t.db, { deviceId, actorUserId: admin, reason: 'admin' })).toBe(false);
    let [row] = await t.db.select().from(devices).where(eq(devices.id, deviceId));
    expect(row?.revokedAt).toBeNull();
    expect(await revokeAudits(deviceId)).toHaveLength(0);

    expect(
      await revokeDevice(t.db, { deviceId, actorUserId: admin, asAdmin: true, reason: 'admin' }),
    ).toBe(true);
    [row] = await t.db.select().from(devices).where(eq(devices.id, deviceId));
    expect(row?.revokedReason).toBe('admin');
    expect((await revokeAudits(deviceId))[0]).toMatchObject({
      actorUserId: admin,
      meta: { reason: 'admin', ownerUserId: owner, asAdmin: true },
    });
  });

  it("doesn't report another user's already revoked device as found", async () => {
    const owner = await seedUser(t.db);
    const stranger = await seedUser(t.db);
    const deviceId = await seedDevice(t.db, owner, {
      revokedAt: new Date(),
      revokedReason: 'user',
    });
    expect(await revokeDevice(t.db, { deviceId, actorUserId: stranger, reason: 'user' })).toBe(
      false,
    );
  });

  it('returns false for unknown and malformed ids', async () => {
    const userId = await seedUser(t.db);
    expect(
      await revokeDevice(t.db, {
        deviceId: '01900000-0000-7000-8000-000000000000',
        actorUserId: userId,
        asAdmin: true,
        reason: 'admin',
      }),
    ).toBe(false);
    expect(await revokeDevice(t.db, { deviceId: '', actorUserId: userId, reason: 'user' })).toBe(
      false,
    );
  });

  it('shows the device as revoked in the list', async () => {
    const userId = await seedUser(t.db);
    const deviceId = await seedDevice(t.db, userId, { outdatedAt: new Date() });
    await revokeDevice(t.db, { deviceId, actorUserId: userId, reason: 'user' });
    const [summary] = await listDevices(t.db, userId);
    expect(summary).toMatchObject({ id: deviceId, status: 'revoked', revokedReason: 'user' });
  });
});
