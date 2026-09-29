import { randomUUID } from 'node:crypto';
import { rawPayloads } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, newHash, wire } from '../ingest/test-support';
import { seedDevice, seedUser } from '../offboarding/test-support';
import { getIngestHealth, HEALTH_MINUTES, type IngestHealth } from './ingest-health';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase('ingesthealth');
});

afterAll(async () => {
  await t.drop();
});

// 30 s into a minute, so the current minute is partial.
const NOW = new Date('2026-09-28T12:00:30Z');
const MIN = 60_000;

async function payload(
  msAgo: number,
  opts: { deviceId?: string | null; status?: number | null; meta?: unknown } = {},
): Promise<void> {
  await t.db.insert(rawPayloads).values({
    receivedAt: new Date(NOW.getTime() - msAgo),
    deviceId: opts.deviceId === undefined ? null : opts.deviceId,
    status: opts.status === undefined ? 200 : opts.status,
    meta: opts.meta ?? null,
    body: '{}',
  });
}

describe('getIngestHealth', () => {
  let health: IngestHealth;
  let alice: string;
  let busy: string;
  let quiet: string;
  const ghost = randomUUID();

  beforeAll(async () => {
    alice = await seedUser(t.db, { name: 'Alice' });
    const bob = await seedUser(t.db, { name: 'Bob' });
    busy = await seedDevice(t.db, alice, { label: 'Main PC', pluginVersion: '1.6.0' });
    quiet = await seedDevice(t.db, bob, { pluginVersion: '1.5' });
    await seedDevice(t.db, bob, { pluginVersion: '1.5' });
    await seedDevice(t.db, alice, { pluginVersion: '1.5.1-SNAPSHOT' });
    await seedDevice(t.db, alice, { pluginVersion: 'weird' });
    await seedDevice(t.db, alice, { pluginVersion: null });
    await seedDevice(t.db, bob, { pluginVersion: '1.4', revokedAt: NOW, revokedReason: 'user' });

    // Current (partial) minute: 3 × 200 from `busy`, 1 × 400 with skipped sections.
    for (let i = 0; i < 3; i++) await payload(10_000, { deviceId: busy });
    await payload(20_000, {
      deviceId: busy,
      status: 400,
      meta: { skippedSections: ['player.inventory', 'player.location'], skippedEvents: 2 },
    });
    // 5 minutes ago: a 503, a pending row and a payload from a device that no longer exists.
    await payload(5 * MIN, { deviceId: quiet, status: 503 });
    await payload(5 * MIN, { deviceId: quiet, status: null });
    await payload(5 * MIN, { deviceId: ghost });
    // The oldest minute of the series (59 minutes before the current one).
    await payload(59 * MIN + 30_000, { deviceId: quiet, meta: { skippedEvents: 1 } });
    // Outside the series and the last hour, inside 24 h.
    await payload(2 * 60 * MIN, {
      deviceId: quiet,
      meta: { skippedSections: ['player.inventory'], skippedEvents: 'x' },
    });
    await payload(23 * 60 * MIN, { status: 401 });
    // Older than 24 h, and in the future: ignored.
    await payload(25 * 60 * MIN, { meta: { skippedEvents: 100 } });
    await payload(-5 * MIN);

    health = await getIngestHealth(t.db, { now: NOW });
  });

  it('counts payloads per minute and status over the last 60 minutes, zero-filled', () => {
    expect(health.perMinute).toHaveLength(HEALTH_MINUTES);
    expect(health.perMinute[0]?.minute).toEqual(new Date('2026-09-28T11:01:00Z'));
    expect(health.perMinute.at(-1)).toEqual({
      minute: new Date('2026-09-28T12:00:00Z'),
      total: 4,
      byStatus: { '200': 3, '400': 1 },
      rejected: {},
    });
    expect(health.perMinute.at(-6)).toEqual({
      minute: new Date('2026-09-28T11:55:00Z'),
      total: 3,
      byStatus: { '200': 1, '503': 1, pending: 1 },
      rejected: {},
    });
    expect(health.perMinute[0]).toMatchObject({ total: 1, byStatus: { '200': 1 } });
    expect(health.perMinute[1]).toMatchObject({ total: 0, byStatus: {} });
    expect(health.perMinute.reduce((n, m) => n + m.total, 0)).toBe(8);
  });

  it('totals by status for the last hour and 24 hours', () => {
    expect(health.lastHour).toEqual({ '200': 5, '400': 1, '503': 1, pending: 1 });
    expect(health.last24h).toEqual({ '200': 6, '400': 1, '503': 1, '401': 1, pending: 1 });
  });

  it('sums skipped sections and events from the payload meta', () => {
    expect(health.skipped).toEqual({
      lastHour: { sections: 2, events: 3, payloads: 2 },
      last24h: { sections: 3, events: 3, payloads: 3 },
    });
    expect(health.topSkippedSections).toEqual([
      { path: 'player.inventory', count: 2 },
      { path: 'player.location', count: 1 },
    ]);
  });

  it('counts non-revoked devices per plugin version, newest first', () => {
    expect(health.pluginVersions).toEqual([
      { version: '1.6.0', devices: 1 },
      { version: '1.5.1-SNAPSHOT', devices: 1 },
      { version: '1.5', devices: 2 },
      { version: 'weird', devices: 1 },
      { version: null, devices: 1 },
    ]);
  });

  it('lists the devices that sent the most payloads in the last hour', () => {
    expect(health.noisyDevices).toEqual([
      {
        deviceId: busy,
        payloads: 4,
        errors: 1,
        label: 'Main PC',
        pluginVersion: '1.6.0',
        revokedAt: null,
        user: { id: alice, name: 'Alice' },
      },
      {
        deviceId: quiet,
        payloads: 3,
        errors: 2,
        label: null,
        pluginVersion: '1.5',
        revokedAt: null,
        user: expect.objectContaining({ name: 'Bob' }),
      },
      {
        deviceId: ghost,
        payloads: 1,
        errors: 0,
        label: null,
        pluginVersion: null,
        revokedAt: null,
        user: null,
      },
    ]);
  });

  it('answers with zeros on an empty archive', async () => {
    const empty = await getIngestHealth(t.db, { now: new Date('2020-01-01T00:00:00Z') });
    expect(empty.perMinute.every((m) => m.total === 0)).toBe(true);
    expect(empty.lastHour).toEqual({});
    expect(empty.last24h).toEqual({});
    expect(empty.skipped.last24h).toEqual({ sections: 0, events: 0, payloads: 0 });
    expect(empty.topSkippedSections).toEqual([]);
    expect(empty.noisyDevices).toEqual([]);
  });
});

describe('getIngestHealth over payloads stored by the real ingest pipeline', () => {
  it("reads the skipped counts ingest writes into raw_payloads.meta, and the device's owner", async () => {
    const h = createHarness(t);
    const userId = await h.seedUser();
    const device = await h.seedDevice(userId);
    const clean = wire('snapshot-normal', { hash: newHash() });
    expect(await h.send(device, clean)).toMatchObject({ status: 200 });
    const messy = wire('event-loot', { hash: newHash(), freshEventIds: true });
    messy.events?.push({ type: 'loot' });
    (messy.player as Record<string, unknown>).location = { x: 'nope' };
    (messy.player as Record<string, unknown>).inventory = 'garbage';
    messy.timestamp = h.clock.now + 1_000;
    expect(await h.send(device, messy)).toMatchObject({ status: 200 });
    const now = new Date(h.clock.now + 1_000);

    const health = await getIngestHealth(t.db, { now });

    expect(health.lastHour).toEqual({ '200': 2 });
    expect(health.skipped.lastHour).toEqual({ sections: 2, events: 1, payloads: 1 });
    expect(health.topSkippedSections.map((s) => s.path).sort()).toEqual([
      'player.inventory',
      'player.location',
    ]);
    expect(health.noisyDevices).toEqual([
      expect.objectContaining({
        deviceId: device.id,
        payloads: 2,
        errors: 0,
        pluginVersion: '1.5',
        user: { id: userId, name: userId },
      }),
    ]);
  });

  it('adds the responses ingest never archived to their minute, from the in-memory count (D-83)', async () => {
    const h = createHarness(t);
    const userId = await h.seedUser();
    const device = await h.seedDevice(userId);
    const body = wire('snapshot-normal', { hash: newHash() });
    expect(await h.send(device, body)).toMatchObject({ status: 200 });
    expect(await h.send(device, body, { token: 'f'.repeat(64) })).toMatchObject({ status: 401 });
    expect(await h.send(device, body, { token: null })).toMatchObject({ status: 401 });
    const now = new Date(h.clock.now);

    const health = await getIngestHealth(t.db, { now, rejected: h.metrics.ingestUnarchived });
    const last = health.perMinute.at(-1);
    expect(last?.rejected).toEqual({ '401': 2 });
    // The archive holds only the accepted payloads (the earlier test's are in this minute too).
    expect(Object.keys(last?.byStatus ?? {})).toEqual(['200']);
    expect(health.perMinute.slice(0, -1).every((m) => Object.keys(m.rejected).length === 0)).toBe(
      true,
    );
    // Without the count handed in, the series is the archive alone.
    const archiveOnly = await getIngestHealth(t.db, { now });
    expect(archiveOnly.perMinute.at(-1)?.rejected).toEqual({});
  });
});
