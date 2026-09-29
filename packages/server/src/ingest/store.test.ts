import {
  LOCATION_BUCKET_MS,
  XP_BUCKET_MS,
  carriedValue,
  floorTo,
  normalizeEvents,
  parsePayload,
  utcDay,
} from '@hub/core';
import {
  accountLinks,
  accountNames,
  deviceAccounts,
  devices,
  equipmentChanges,
  events,
  latestState,
  locationSamples,
  osrsAccounts,
  playSessions,
  rawPayloads,
  skills,
  wealthDaily,
  xpSamples,
} from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { fixtureBody, type FixtureName } from '@hub/fixtures';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_EVENTS_PER_PAYLOAD } from './limits';
import {
  captureLogger,
  counterValue,
  createHarness,
  newEventId,
  newHash,
  realTotalLevel,
  wire,
  type Harness,
  type SeededDevice,
  type Wire,
} from './test-support';

let t: TestDatabase;
let h: Harness;

beforeAll(async () => {
  t = await createTestDatabase('ingest_store');
  h = createHarness(t);
});

afterAll(async () => {
  await t.drop();
});

// ---- query helpers -------------------------------------------------------------------------------

async function account(hash: string) {
  const [row] = await t.db.select().from(osrsAccounts).where(eq(osrsAccounts.accountHash, hash));
  if (!row) throw new Error(`no account for ${hash}`);
  return row;
}

async function latest(accountId: number) {
  const [row] = await t.db.select().from(latestState).where(eq(latestState.accountId, accountId));
  if (!row) throw new Error('no latest_state');
  return row;
}

const xpRows = (accountId: number) =>
  t.db.select().from(xpSamples).where(eq(xpSamples.accountId, accountId));
const eventRows = (accountId: number) =>
  t.db.select().from(events).where(eq(events.accountId, accountId)).orderBy(asc(events.seq));
const sessions = (accountId: number) =>
  t.db
    .select()
    .from(playSessions)
    .where(eq(playSessions.accountId, accountId))
    .orderBy(asc(playSessions.startedAt));
const equipmentRows = (accountId: number) =>
  t.db.select().from(equipmentChanges).where(eq(equipmentChanges.accountId, accountId));

async function lastArchive(deviceId: string) {
  const rows = await t.db
    .select()
    .from(rawPayloads)
    .where(eq(rawPayloads.deviceId, deviceId))
    .orderBy(asc(rawPayloads.receivedAt));
  return rows.at(-1);
}

async function skillId(name: string): Promise<number> {
  const [row] = await t.db.select({ id: skills.id }).from(skills).where(eq(skills.name, name));
  if (!row) throw new Error(`no skill ${name}`);
  return row.id;
}

type WirePlayer = NonNullable<Wire['player']> & {
  health: { current: number; max: number };
  prayerPoints: { current: number; max: number };
  spellbook: { id: number; name: string };
  location: { x: number; y: number; plane: number; isOnBoat?: boolean };
  inventory: { items: unknown[] };
  equipment: { items: unknown[] };
  world: string;
  worldTypes: string[];
};
const playerOf = (body: Wire) => body.player as WirePlayer;
const ts = (body: Wire) => body.timestamp as number;

// ---- first snapshot ------------------------------------------------------------------------------

describe('first snapshot of a new account', () => {
  let device: SeededDevice;
  let body: Wire;
  let recv: Date;
  let accountId: number;

  beforeAll(async () => {
    device = await h.seedDevice();
    body = wire('snapshot-normal', { hash: newHash() });
    recv = new Date(ts(body) + 1_000);
    expect(await h.send(device, body)).toEqual({ status: 200, body: { ok: true } });
    accountId = (await account(body.player?.accountHash as string)).id;
  });

  it('creates the account with a 12-character public id, owned by the reporter', async () => {
    const row = await account(body.player?.accountHash as string);
    expect(row.publicId).toMatch(/^[0-9A-Za-z]{12}$/);
    expect(row).toMatchObject({
      currentName: 'Zezima',
      nameNormalized: 'zezima',
      accountType: 0,
      ownerUserId: device.userId,
      firstSeen: recv,
      lastSeen: recv,
      status: 'active',
    });
    const names = await t.db
      .select()
      .from(accountNames)
      .where(eq(accountNames.accountId, accountId));
    expect(names).toEqual([{ accountId, name: 'Zezima', firstSeen: recv, lastSeen: recv }]);
  });

  it('links the user as owner and the device to the account', async () => {
    const links = await t.db
      .select()
      .from(accountLinks)
      .where(eq(accountLinks.accountId, accountId));
    expect(links).toMatchObject([{ userId: device.userId, role: 'owner', blocked: false }]);
    const da = await t.db
      .select()
      .from(deviceAccounts)
      .where(eq(deviceAccounts.accountId, accountId));
    expect(da).toMatchObject([{ deviceId: device.id, firstSeen: recv, lastSeen: recv }]);
    const [d] = await t.db.select().from(devices).where(eq(devices.id, device.id));
    expect(d).toMatchObject({
      lastSeenAt: recv,
      firstDataAt: recv,
      lastIp: '203.0.113.7',
      pluginVersion: '1.5',
      outdatedAt: null,
    });
  });

  it('writes latest_state with every section and its own updated_at', async () => {
    const p = playerOf(body);
    expect(await latest(accountId)).toEqual({
      accountId,
      sourceDeviceId: device.id,
      sourceTs: new Date(ts(body)),
      lastSeen: recv,
      lastDeviceId: device.id,
      gameState: 'LOGGED_IN',
      tickDelay: 100,
      world: 302,
      worldTypes: ['MEMBERS'],
      specialWorld: false,
      worldUpdatedAt: recv,
      hpCurrent: p.health.current,
      hpMax: p.health.max,
      healthUpdatedAt: recv,
      prayerCurrent: p.prayerPoints.current,
      prayerMax: p.prayerPoints.max,
      prayerUpdatedAt: recv,
      spellbookId: p.spellbook.id,
      spellbook: p.spellbook.name,
      spellbookUpdatedAt: recv,
      location: p.location,
      locationUpdatedAt: recv,
      skills: p.stats?.skills,
      skillsUpdatedAt: recv,
      inventory: p.inventory.items,
      inventoryUpdatedAt: recv,
      equipment: p.equipment.items,
      equipmentUpdatedAt: recv,
      updatedAt: recv,
    });
  });

  it('writes 25 XP samples (24 skills + Overall with the real total level, D-44)', async () => {
    const rows = await xpRows(accountId);
    expect(rows).toHaveLength(25);
    const bucket = floorTo(recv, XP_BUCKET_MS);
    expect(rows.every((r) => r.bucket.getTime() === bucket.getTime())).toBe(true);
    const overallId = await skillId('Overall');
    const overall = rows.find((r) => r.skillId === overallId);
    const sent = Object.values(playerOf(body).stats?.skills ?? {});
    expect(overall).toMatchObject({
      xp: sent.reduce((s, v) => s + v.xp, 0),
      level: realTotalLevel(body),
    });
    expect(realTotalLevel(body)).toBeLessThan(sent.reduce((s, v) => s + v.level, 0));
    const attackId = await skillId('Attack');
    expect(rows.find((r) => r.skillId === attackId)).toMatchObject({ xp: 34512847, level: 108 });
  });

  it('records one equipment change, one location sample and the day’s wealth', async () => {
    const p = playerOf(body);
    const eq1 = await equipmentRows(accountId);
    expect(eq1).toMatchObject([{ changedAt: recv, equipment: p.equipment.items }]);
    const loc = await t.db
      .select()
      .from(locationSamples)
      .where(eq(locationSamples.accountId, accountId));
    expect(loc).toEqual([
      {
        accountId,
        ts: floorTo(recv, LOCATION_BUCKET_MS),
        x: p.location.x,
        y: p.location.y,
        plane: p.location.plane,
        world: 302,
        onBoat: false,
      },
    ]);
    const wealth = await t.db
      .select()
      .from(wealthDaily)
      .where(eq(wealthDaily.accountId, accountId));
    const value = carriedValue(p.inventory.items, p.equipment.items);
    expect(value).toBeGreaterThan(0);
    expect(wealth).toEqual([
      { accountId, day: utcDay(recv), lastValue: value, maxValue: value, updatedAt: recv },
    ]);
  });

  it('opens a play session on the world', async () => {
    expect(await sessions(accountId)).toMatchObject([
      {
        deviceId: device.id,
        startedAt: recv,
        lastSeenAt: recv,
        endedAt: null,
        endReason: null,
        worlds: [302],
      },
    ]);
  });

  it('records the outcome on the archive row', async () => {
    expect(await lastArchive(device.id)).toMatchObject({
      status: 200,
      accountId,
      meta: { inserted: 0, duplicates: 0 },
    });
  });

  it('the same snapshot again adds no XP or equipment rows but refreshes presence', async () => {
    const again = new Date(recv.getTime() + 60_000);
    expect((await h.send(device, body, { at: again.getTime() })).status).toBe(200);
    expect(await xpRows(accountId)).toHaveLength(25);
    expect(await equipmentRows(accountId)).toHaveLength(1);
    const row = await latest(accountId);
    expect(row.lastSeen).toEqual(again);
    expect((await account(body.player?.accountHash as string)).lastSeen).toEqual(again);
    expect(await sessions(accountId)).toMatchObject([{ lastSeenAt: again, endedAt: null }]);
    const [d] = await t.db.select().from(devices).where(eq(devices.id, device.id));
    expect(d?.firstDataAt).toEqual(recv);
  });

  it('a snapshot without inventory/equipment/location keeps those sections (D-18)', async () => {
    const before = await latest(accountId);
    const partial = wire('snapshot-no-sections', { hash: body.player?.accountHash as string });
    const at = recv.getTime() + 120_000;
    partial.timestamp = at - 1_000;
    expect((await h.send(device, partial, { at })).status).toBe(200);
    const after = await latest(accountId);
    expect(after.location).toEqual(before.location);
    expect(after.locationUpdatedAt).toEqual(before.locationUpdatedAt);
    expect(after.inventory).toEqual(before.inventory);
    expect(after.equipmentUpdatedAt).toEqual(before.equipmentUpdatedAt);
    expect(after.healthUpdatedAt).toEqual(new Date(at));
    expect(after.sourceTs).toEqual(new Date(at - 1_000));
  });
});

// ---- events --------------------------------------------------------------------------------------

describe('events', () => {
  const EVENT_FIXTURES: FixtureName[] = [
    'event-loot',
    'event-pkloot',
    'event-death-dangerous',
    'event-death-safe',
    'event-levelup-multi',
    'event-collectionlog',
    'event-collectionlog-unresolved',
    'event-superior',
    'event-diary-repeat',
    'event-combattask',
    'event-unknown-type',
  ];

  it.each(EVENT_FIXTURES)('%s is stored with the normalized columns', async (name) => {
    const device = await h.seedDevice();
    const body = wire(name, { hash: newHash() });
    const recv = new Date(ts(body) + 1_000);
    const res = await h.send(device, body);
    expect(res.status).toBe(200);

    const parsed = parsePayload(fixtureBody(name));
    if (!parsed.ok) throw new Error('fixture must parse');
    const expected = normalizeEvents(parsed.payload.events, recv).events;
    const { id: accountId } = await account(body.player?.accountHash as string);
    const rows = await eventRows(accountId);
    expect(rows).toHaveLength(expected.length);
    expect(expected.length).toBeGreaterThan(0);
    rows.forEach((row, i) => {
      const e = expected[i];
      expect(row).toMatchObject({
        pluginEventId: e?.pluginEventId,
        subIndex: e?.subIndex,
        type: e?.type,
        occurredAt: e?.occurredAt,
        receivedAt: recv,
        valueGp: e?.valueGp,
        itemId: e?.itemId,
        npcId: e?.npcId,
        skill: e?.skill,
        level: e?.level,
        tier: e?.tier,
        points: e?.points,
        specialWorld: false,
        deviceId: device.id,
        data: e?.data,
      });
      expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    });
    expect(await lastArchive(device.id)).toMatchObject({
      meta: { inserted: expected.length, duplicates: 0 },
    });
  });

  it('spot checks: loot, level-ups, combat task, unresolved clog, unknown type, diary repeats', async () => {
    const device = await h.seedDevice();
    const stored = async (name: FixtureName) => {
      const body = wire(name, { hash: newHash() });
      await h.send(device, body);
      return eventRows((await account(body.player?.accountHash as string)).id);
    };
    const [loot] = await stored('event-loot');
    expect(loot).toMatchObject({ type: 'loot', npcId: 3162, occurredAt: new Date(1790005400233) });
    expect(loot?.valueGp).toBeGreaterThan(0);
    expect(
      (await stored('event-levelup-multi')).map((r) => [r.subIndex, r.skill, r.level]),
    ).toEqual([
      [0, 'Hitpoints', 84],
      [1, 'Combat', 101],
      [2, 'Strength', 85],
    ]);
    expect(await stored('event-combattask')).toMatchObject([
      { type: 'combat_task', tier: 'grandmaster', points: 6 },
    ]);
    expect(await stored('event-collectionlog-unresolved')).toMatchObject([
      { type: 'collection_log', itemId: null, valueGp: 0 },
    ]);
    expect(await stored('event-unknown-type')).toMatchObject([{ type: 'questComplete' }]);
    expect(await stored('event-diary-repeat')).toMatchObject([
      { type: 'achievement_diary', tier: 'easy' },
      { type: 'achievement_diary', tier: 'easy' },
    ]);
    expect(await counterValue(h.metrics.ingestEvents, { type: 'other' })).toBeGreaterThan(0);
  });

  it('strips NUL from stored event data (DB-1)', async () => {
    const device = await h.seedDevice();
    const body = wire('event-unknown-type', { hash: newHash(), freshEventIds: true });
    (body.events?.[0] as { data: Record<string, unknown> }).data.questName = 'A\u0000B';
    expect((await h.send(device, body)).status).toBe(200);
    const [row] = await eventRows((await account(body.player?.accountHash as string)).id);
    expect((row?.data as { data: { questName: string } }).data.questName).toBe('AB');
  });

  it('retry-duplicate-a then -b: both 200, one set of rows (D-16)', async () => {
    const device = await h.seedDevice();
    const hash = newHash();
    const dupesBefore = await counterValue(h.metrics.ingestDuplicates);
    expect((await h.send(device, wire('retry-duplicate-a', { hash }))).status).toBe(200);
    const b = wire('retry-duplicate-b', { hash });
    expect((await h.send(device, b, { at: ts(b) + 31_000 })).status).toBe(200);
    const { id } = await account(hash);
    expect(await eventRows(id)).toHaveLength(1);
    expect(await lastArchive(device.id)).toMatchObject({ meta: { inserted: 0, duplicates: 1 } });
    expect(await counterValue(h.metrics.ingestDuplicates)).toBe(dupesBefore + 1);
  });

  it('the same event from a second device of the same player is stored once (PLUGIN-10)', async () => {
    const userId = await h.seedUser();
    const [d1, d2] = [await h.seedDevice(userId), await h.seedDevice(userId)];
    const body = wire('event-superior', { hash: newHash(), freshEventIds: true });
    expect((await h.send(d1, body)).status).toBe(200);
    expect((await h.send(d2, body)).status).toBe(200);
    expect(await eventRows((await account(body.player?.accountHash as string)).id)).toHaveLength(1);
  });

  it(`handles at most ${MAX_EVENTS_PER_PAYLOAD} events per payload; the rest count as skipped`, async () => {
    const device = await h.seedDevice();
    const body = wire('event-diary-repeat', { hash: newHash() });
    const template = body.events?.[0] as Record<string, unknown>;
    body.events = Array.from({ length: MAX_EVENTS_PER_PAYLOAD + 5 }, () => ({
      ...template,
      eventId: newEventId(),
    }));
    const skippedBefore = await counterValue(h.metrics.ingestSkippedEvents);
    expect((await h.send(device, body)).status).toBe(200);
    const { id } = await account(body.player?.accountHash as string);
    expect(await eventRows(id)).toHaveLength(MAX_EVENTS_PER_PAYLOAD);
    expect(await lastArchive(device.id)).toMatchObject({
      meta: { inserted: MAX_EVENTS_PER_PAYLOAD, skippedEvents: 5 },
    });
    expect(await counterValue(h.metrics.ingestSkippedEvents)).toBe(skippedBefore + 5);
  });

  it('counts malformed events and sections as skipped but stores the rest', async () => {
    const device = await h.seedDevice();
    const body = wire('event-loot', { hash: newHash(), freshEventIds: true });
    body.events?.push({ type: 'loot' }, { type: 'levelUp', data: 'x', eventId: newEventId() });
    (body.player as Record<string, unknown>).location = { x: 'nope' };
    expect((await h.send(device, body)).status).toBe(200);
    const { id } = await account(body.player?.accountHash as string);
    expect(await eventRows(id)).toHaveLength(1);
    expect(await lastArchive(device.id)).toMatchObject({
      meta: { inserted: 1, skippedEvents: 2, skippedSections: ['player.location'] },
    });
  });
});

// ---- staleness and ordering ----------------------------------------------------------------------

describe('staleness (D-17, D-33)', () => {
  it('a resend older than the overtaking snapshot from the same device is stale; its events are stored', async () => {
    const device = await h.seedDevice();
    const hash = newHash();
    const overtaking = wire('retry-overtaking-snapshot', { hash });
    playerOf(overtaking).health.current = 42;
    const resend = wire('retry-duplicate-b', { hash });
    resend.state = 'LOADING';
    playerOf(resend).health.current = 77;

    expect((await h.send(device, overtaking)).status).toBe(200);
    const resendAt = ts(overtaking) + 30_000;
    expect((await h.send(device, resend, { at: resendAt })).status).toBe(200);

    const { id } = await account(hash);
    const row = await latest(id);
    expect(row).toMatchObject({
      sourceDeviceId: device.id,
      sourceTs: new Date(ts(overtaking)),
      hpCurrent: 42,
      gameState: 'LOGGED_IN',
      lastSeen: new Date(resendAt),
      lastDeviceId: device.id,
    });
    expect(await eventRows(id)).toHaveLength(1);
    expect(await lastArchive(device.id)).toMatchObject({ meta: { stale: true, inserted: 1 } });
  });

  it('an older timestamp from ANOTHER device is not stale (clocks differ between PCs)', async () => {
    const userId = await h.seedUser();
    const [a, b] = [await h.seedDevice(userId), await h.seedDevice(userId)];
    const hash = newHash();
    const overtaking = wire('retry-overtaking-snapshot', { hash });
    playerOf(overtaking).health.current = 42;
    const older = wire('retry-duplicate-b', { hash });
    playerOf(older).health.current = 77;

    await h.send(a, overtaking);
    expect((await h.send(b, older, { at: ts(overtaking) + 30_000 })).status).toBe(200);

    const row = await latest((await account(hash)).id);
    expect(row).toMatchObject({
      sourceDeviceId: b.id,
      sourceTs: new Date(ts(older)),
      hpCurrent: 77,
      lastDeviceId: b.id,
    });
  });

  it('combat bursts arriving out of order: the older one is stale, the next tick applies', async () => {
    const device = await h.seedDevice();
    const hash = newHash();
    const [b1, b2, b3] = (
      ['snapshot-combat-burst-1', 'snapshot-combat-burst-2', 'snapshot-combat-burst-3'] as const
    ).map((n) => wire(n, { hash }));
    if (!b1 || !b2 || !b3) throw new Error('fixtures');
    expect(playerOf(b1).prayerPoints.current).not.toBe(playerOf(b2).prayerPoints.current);

    await h.send(device, b2);
    await h.send(device, b1, { at: ts(b2) + 1_001 });
    const { id } = await account(hash);
    expect(await latest(id)).toMatchObject({
      prayerCurrent: playerOf(b2).prayerPoints.current,
      sourceTs: new Date(ts(b2)),
    });
    expect(await lastArchive(device.id)).toMatchObject({ meta: { stale: true } });

    await h.send(device, b3);
    const row = await latest(id);
    expect(row.sourceTs).toEqual(new Date(ts(b3)));
    expect(row.location).toEqual(playerOf(b3).location);
    const xp = await xpRows(id);
    expect(xp).toHaveLength(25);
    const xpOf = async (skill: string) => {
      const id = await skillId(skill);
      return xp.find((r) => r.skillId === id)?.xp;
    };
    const sent = playerOf(b3).stats?.skills ?? {};
    expect(await xpOf('Attack')).toBe(sent.Attack?.xp);
    expect(await xpOf('Hitpoints')).toBe(sent.Hitpoints?.xp);
    expect(await xpOf('Overall')).toBe(Object.values(sent).reduce((s, v) => s + v.xp, 0));
  });
});

// ---- special worlds and the XP guard -------------------------------------------------------------

describe('special worlds (handoff §7.1.9) and the XP guard (D-24)', () => {
  async function seedNormal(device: SeededDevice, hash: string) {
    const normal = wire('snapshot-normal', { hash });
    await h.send(device, normal);
    const { id } = await account(hash);
    return { id, normal, before: await latest(id) };
  }

  it('special-world-seasonal: live fields only, no XP, events flagged, session tracks the world', async () => {
    const device = await h.seedDevice();
    const hash = newHash();
    const { id, before } = await seedNormal(device, hash);
    const seasonal = wire('special-world-seasonal', { hash });
    (seasonal.player as Record<string, unknown>).accountType = '2';

    expect((await h.send(device, seasonal)).status).toBe(200);

    const recv = new Date(ts(seasonal) + 1_000);
    const row = await latest(id);
    expect(row).toMatchObject({
      world: 485,
      worldTypes: ['MEMBERS', 'SEASONAL'],
      specialWorld: true,
      worldUpdatedAt: recv,
      gameState: 'LOGGED_IN',
      lastSeen: recv,
      skills: before.skills,
      skillsUpdatedAt: before.skillsUpdatedAt,
      inventory: before.inventory,
      sourceTs: before.sourceTs,
      hpCurrent: before.hpCurrent,
      location: before.location,
    });
    expect(await xpRows(id)).toHaveLength(25);
    expect(await equipmentRows(id)).toHaveLength(1);
    expect(await eventRows(id)).toMatchObject([
      { type: 'level_up', skill: 'Woodcutting', level: 41, specialWorld: true },
    ]);
    expect((await sessions(id)).map((s) => s.worlds)).toEqual([[302, 485]]);
    expect(await lastArchive(device.id)).toMatchObject({ meta: { special: true, inserted: 1 } });
    expect((await account(hash)).accountType).toBe(0);
  });

  it('hop-from-special-world-stale: classified by the payload’s own worldTypes (PLUGIN-8)', async () => {
    const device = await h.seedDevice();
    const hash = newHash();
    const { id, before } = await seedNormal(device, hash);
    const hop = wire('hop-from-special-world-stale', { hash });

    expect((await h.send(device, hop)).status).toBe(200);

    expect(await latest(id)).toMatchObject({
      world: 485,
      specialWorld: true,
      skills: before.skills,
      inventory: before.inventory,
      equipment: before.equipment,
    });
    expect(await xpRows(id)).toHaveLength(25);
    expect(await equipmentRows(id)).toHaveLength(1);
  });

  it('an XP drop on a normal world skips XP and derived writes and logs the skill', async () => {
    const { logger, lines } = captureLogger();
    const g = createHarness(t, { logger });
    const device = await g.seedDevice();
    const hash = newHash();
    const normal = wire('snapshot-normal', { hash });
    await g.send(device, normal);
    const { id } = await account(hash);
    const before = await latest(id);

    const dropped = wire('snapshot-normal', { hash });
    dropped.timestamp = ts(normal) + 60_000;
    const p = playerOf(dropped);
    const attack = p.stats?.skills.Attack;
    if (!attack) throw new Error('fixture');
    attack.xp -= 1_000;
    p.world = '303';
    p.location.x += 5;
    p.equipment.items = [];
    expect((await g.send(device, dropped)).status).toBe(200);

    expect(await latest(id)).toMatchObject({
      world: 303,
      specialWorld: false,
      skills: before.skills,
      location: before.location,
      equipment: before.equipment,
      sourceTs: before.sourceTs,
    });
    expect(await xpRows(id)).toHaveLength(25);
    expect(await equipmentRows(id)).toHaveLength(1);
    const archived = await t.db
      .select({ meta: rawPayloads.meta })
      .from(rawPayloads)
      .where(and(eq(rawPayloads.deviceId, device.id), eq(rawPayloads.accountId, id)));
    expect(archived.map((r) => r.meta)).toContainEqual(
      expect.objectContaining({ xpGuard: 'Attack' }),
    );
    const warn = lines.find((l) => l.skill === 'Attack');
    expect(warn).toMatchObject({ level: 40, accountId: id });
    expect(Object.keys(warn ?? {}).sort()).toEqual(
      ['accountId', 'hostname', 'level', 'msg', 'pid', 'skill', 'time'].sort(),
    );
  });
});

// ---- identity: renames, name-only payloads, missing identity ------------------------------------

describe('identity', () => {
  it('a rename keeps the account and records both names (D-15)', async () => {
    const device = await h.seedDevice();
    const hash = newHash();
    const first = wire('snapshot-normal', { hash, name: 'Old Name' });
    await h.send(device, first);
    const renamed = wire('snapshot-normal', { hash, name: 'New_Name' });
    renamed.timestamp = ts(first) + 600_000;
    (renamed.player as Record<string, unknown>).accountType = '3';
    expect((await h.send(device, renamed)).status).toBe(200);

    const row = await account(hash);
    expect(row).toMatchObject({
      currentName: 'New_Name',
      nameNormalized: 'new name',
      accountType: 3,
    });
    const names = await t.db
      .select({ name: accountNames.name })
      .from(accountNames)
      .where(eq(accountNames.accountId, row.id))
      .orderBy(asc(accountNames.firstSeen));
    expect(names.map((n) => n.name)).toEqual(['Old Name', 'New_Name']);
  });

  it('a name without accountHash matches exactly one current name', async () => {
    const { logger, lines } = captureLogger();
    const g = createHarness(t, { logger });
    const device = await g.seedDevice();
    const hash = newHash();
    await g.send(device, wire('snapshot-normal', { hash, name: 'Name Only Test' }));
    const nameOnly = wire('snapshot-normal', { name: 'name_only-test' });
    delete nameOnly.player?.accountHash;
    nameOnly.timestamp = (nameOnly.timestamp as number) + 60_000;
    playerOf(nameOnly).health.current = 11;

    expect((await g.send(device, nameOnly)).status).toBe(200);

    const { id } = await account(hash);
    expect((await latest(id)).hpCurrent).toBe(11);
    expect(lines.some((l) => l.accountId === id && l.level === 40)).toBe(true);
  });

  it('a name without accountHash and no (or several) matches → 400 unknown_account', async () => {
    const device = await h.seedDevice();
    const unknown = wire('snapshot-normal', { name: 'Nobody Here' });
    delete unknown.player?.accountHash;
    expect(await h.send(device, unknown)).toEqual({
      status: 400,
      body: { ok: false, error: 'unknown_account' },
    });
    expect(await lastArchive(device.id)).toMatchObject({
      status: 400,
      accountId: null,
      meta: { error: 'unknown_account' },
    });

    await h.send(device, wire('snapshot-normal', { hash: newHash(), name: 'Twin' }));
    await h.send(device, wire('snapshot-normal', { hash: newHash(), name: 'twin' }));
    const twin = wire('snapshot-normal', { name: 'TWIN' });
    delete twin.player?.accountHash;
    expect((await h.send(device, twin)).status).toBe(400);
  });

  it('never matches an empty normalized name', async () => {
    const device = await h.seedDevice();
    // An account first seen without a name has the placeholder name and an empty name_normalized.
    const hashOnly = wire('snapshot-normal', { hash: newHash() });
    delete hashOnly.player?.name;
    expect((await h.send(device, hashOnly)).status).toBe(200);
    expect(await account(hashOnly.player?.accountHash as string)).toMatchObject({
      currentName: 'Unknown',
      nameNormalized: '',
    });

    const blank = wire('snapshot-normal', { name: ' ' });
    delete blank.player?.accountHash;
    expect((await h.send(device, blank)).body).toEqual({ ok: false, error: 'unknown_account' });
  });

  it('login-partial-player (no name, no hash) → 200 ignored, no account (D-29)', async () => {
    const device = await h.seedDevice();
    const before = await t.db.select({ id: osrsAccounts.id }).from(osrsAccounts);
    const ignoredBefore = await counterValue(h.metrics.ingestIgnored, { reason: 'no_identity' });

    expect(await h.send(device, wire('login-partial-player'))).toEqual({
      status: 200,
      body: { ok: true },
    });

    expect(await t.db.select({ id: osrsAccounts.id }).from(osrsAccounts)).toHaveLength(
      before.length,
    );
    expect(await lastArchive(device.id)).toMatchObject({
      status: 200,
      accountId: null,
      meta: { ignored: 'no_identity' },
    });
    expect(await counterValue(h.metrics.ingestIgnored, { reason: 'no_identity' })).toBe(
      ignoredBefore + 1,
    );
    const [d] = await t.db.select().from(devices).where(eq(devices.id, device.id));
    expect(d?.lastSeenAt).not.toBeNull();
    expect(d?.firstDataAt).toBeNull();
  });
});

// ---- sessions ------------------------------------------------------------------------------------

describe('play sessions', () => {
  it('logout ends the session with reason logout at the shutdown time', async () => {
    const device = await h.seedDevice();
    const hash = newHash();
    await h.send(device, wire('snapshot-normal', { hash }));
    const logout = wire('logout', { hash });
    expect((await h.send(device, logout)).status).toBe(200);

    const { id } = await account(hash);
    const shutdownAt = (logout.events?.[0] as { timestamp: number }).timestamp;
    expect(await sessions(id)).toMatchObject([
      { endedAt: new Date(shutdownAt), endReason: 'logout', worlds: [302] },
    ]);
    expect((await latest(id)).gameState).toBe('LOGIN_SCREEN');
    expect(await eventRows(id)).toEqual([]);
  });

  it('shutdown while logged in closes the open session without opening a new one', async () => {
    const device = await h.seedDevice();
    const hash = newHash();
    await h.send(device, wire('snapshot-normal', { hash }));
    expect((await h.send(device, wire('shutdown', { hash }))).status).toBe(200);
    const { id } = await account(hash);
    expect(await sessions(id)).toMatchObject([{ endReason: 'shutdown' }]);
    expect((await sessions(id))[0]?.endedAt).not.toBeNull();
  });

  it('a first payload that is LOGGED_IN + Shutdown opens no session', async () => {
    const device = await h.seedDevice();
    const hash = newHash();
    expect((await h.send(device, wire('shutdown', { hash }))).status).toBe(200);
    expect(await sessions((await account(hash)).id)).toEqual([]);
  });

  it('logout-client-start-no-player closes this device’s sessions (never before they started)', async () => {
    const device = await h.seedDevice();
    const other = await h.seedDevice();
    const [hash, otherHash] = [newHash(), newHash()];
    const snapshot = wire('snapshot-normal', { hash });
    await h.send(device, snapshot);
    await h.send(other, wire('snapshot-normal', { hash: otherHash }));
    const started = new Date(ts(snapshot) + 1_000);

    const res = await h.send(device, wire('logout-client-start-no-player'), {
      at: started.getTime() + 300_000,
    });

    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(await sessions((await account(hash)).id)).toMatchObject([
      { endedAt: started, endReason: 'logout' },
    ]);
    expect(await sessions((await account(otherHash)).id)).toMatchObject([{ endedAt: null }]);
    expect(await lastArchive(device.id)).toMatchObject({
      status: 200,
      accountId: null,
      meta: { closedSessions: 1 },
    });
  });

  it('disabled-login-screen closes sessions with reason disabled, or creates nothing', async () => {
    const device = await h.seedDevice();
    const hash = newHash();
    await h.send(device, wire('snapshot-normal', { hash }));
    const disabled = wire('disabled-login-screen');
    expect((await h.send(device, disabled)).status).toBe(200);
    const shutdownAt = (disabled.events?.[0] as { timestamp: number }).timestamp;
    expect(await sessions((await account(hash)).id)).toMatchObject([
      { endedAt: new Date(shutdownAt), endReason: 'disabled' },
    ]);

    const idle = await h.seedDevice();
    const before = await t.db.select({ id: playSessions.id }).from(playSessions);
    expect((await h.send(idle, disabled)).status).toBe(200);
    expect(await t.db.select({ id: playSessions.id }).from(playSessions)).toHaveLength(
      before.length,
    );
    expect(await lastArchive(idle.id)).toMatchObject({ meta: { closedSessions: 0 } });
  });

  it('a world hop extends the session and records the new world', async () => {
    const device = await h.seedDevice();
    const hash = newHash();
    await h.send(device, wire('snapshot-normal', { hash }));
    const hop = wire('snapshot-world-hop', { hash });
    await h.send(device, hop);
    const { id } = await account(hash);
    expect(await sessions(id)).toMatchObject([
      { worlds: [302, 330], lastSeenAt: new Date(ts(hop) + 1_000), endedAt: null },
    ]);
    const open = await t.db
      .select()
      .from(playSessions)
      .where(and(eq(playSessions.accountId, id), isNull(playSessions.endedAt)));
    expect(open).toHaveLength(1);
  });
});

// ---- links ---------------------------------------------------------------------------------------

describe('owners and contributors (handoff §7.1.7)', () => {
  it('a second user reporting the account becomes a contributor; a blocked one stores nothing', async () => {
    const owner = await h.seedDevice();
    const contributor = await h.seedDevice();
    const hash = newHash();
    await h.send(owner, wire('snapshot-normal', { hash }));
    const second = wire('snapshot-world-hop', { hash });
    expect((await h.send(contributor, second)).status).toBe(200);

    const { id, ownerUserId } = await account(hash);
    expect(ownerUserId).toBe(owner.userId);
    const links = await t.db
      .select({ userId: accountLinks.userId, role: accountLinks.role })
      .from(accountLinks)
      .where(eq(accountLinks.accountId, id));
    expect(links).toEqual(
      expect.arrayContaining([
        { userId: owner.userId, role: 'owner' },
        { userId: contributor.userId, role: 'contributor' },
      ]),
    );

    await t.db
      .update(accountLinks)
      .set({ blocked: true, blockedAt: new Date() })
      .where(and(eq(accountLinks.accountId, id), eq(accountLinks.userId, contributor.userId)));
    const before = await latest(id);
    const [daBefore] = await t.db
      .select()
      .from(deviceAccounts)
      .where(eq(deviceAccounts.deviceId, contributor.id));
    const ignoredBefore = await counterValue(h.metrics.ingestIgnored, { reason: 'blocked' });

    const loot = wire('event-loot', { hash, freshEventIds: true });
    expect(await h.send(contributor, loot)).toEqual({ status: 200, body: { ok: true } });

    expect(await eventRows(id)).toEqual([]);
    expect(await latest(id)).toEqual(before);
    const [daAfter] = await t.db
      .select()
      .from(deviceAccounts)
      .where(eq(deviceAccounts.deviceId, contributor.id));
    expect(daAfter).toEqual(daBefore);
    expect(await lastArchive(contributor.id)).toMatchObject({
      status: 200,
      accountId: id,
      meta: { ignored: 'blocked' },
    });
    expect(await counterValue(h.metrics.ingestIgnored, { reason: 'blocked' })).toBe(
      ignoredBefore + 1,
    );
  });
});

// ---- skills table growth -------------------------------------------------------------------------

describe('skills', () => {
  it('a skill name the hub has not seen is added and sampled', async () => {
    const device = await h.seedDevice();
    const hash = newHash();
    const body = wire('snapshot-normal', { hash });
    const sent = playerOf(body).stats?.skills;
    if (!sent) throw new Error('fixture');
    sent.Necromancy = { xp: 1_234, level: 10 };
    expect((await h.send(device, body)).status).toBe(200);
    const [row] = await t.db.select().from(skills).where(eq(skills.name, 'Necromancy'));
    expect(row).toMatchObject({ kind: 'plugin', sortOrder: 1000 });
    const xp = await xpRows((await account(hash)).id);
    expect(xp).toHaveLength(26);
    expect(xp.find((r) => r.skillId === row?.id)).toMatchObject({ xp: 1_234, level: 10 });
  });
});
