/**
 * Integration: every v1.5 fixture through the whole pure ingest chain, as the server runs it —
 * parsePayload → normalizeEvents → planSnapshot — checked against the hub behaviour the fixture
 * README and handoff §7 describe. Expectations are derived from the wire bodies, not from the code.
 */
import {
  FIXTURES,
  FIXTURE_ACCOUNTS,
  fixtureBody,
  fixtureJson,
  payloadFilesOnDisk,
  type FixtureName,
} from '@hub/fixtures';
import { describe, expect, it } from 'vitest';
import { normalizeEvents } from './events/normalize';
import type { NormalizedEvent, NormalizeResult, ShutdownReason } from './events/types';
import { planSnapshot } from './ingest/plan';
import type { LatestStatePatch, PrevState, SnapshotPlan } from './ingest/types';
import { parsePayload } from './payload/parse';
import type { ParsedPayload } from './payload/types';
import { KNOWN_SKILLS, OVERALL } from './skills';
import { payloadTime } from './time';

// ---------------------------------------------------------------------------------------------
// Wire shapes (strings where the plugin sends strings)

interface WireItem {
  id: number;
  gePrice: number;
  quantity: number;
  equipmentSlot?: string;
}

interface WireSkill {
  xp: number;
  level: number;
}

interface WireMeter {
  current: number;
  max: number;
}

interface WireEvent {
  type: string;
  data: unknown;
  eventId: string;
  timestamp: number;
}

interface WirePlayer {
  name?: string;
  accountHash?: string;
  accountType?: string;
  world?: string;
  worldTypes?: string[];
  location?: { x: number; y: number; plane: number; isOnBoat?: boolean };
  locationTrail?: { x: number; y: number; plane: number; isOnBoat?: boolean; timestamp: number }[];
  health?: WireMeter;
  prayerPoints?: WireMeter;
  spellbook?: { id: number; name: string };
  stats?: { skills: Record<string, WireSkill> };
  inventory?: { items: WireItem[] };
  equipment?: { items: WireItem[] };
}

interface WireBody {
  player?: WirePlayer;
  events?: WireEvent[];
  state?: string;
  tickDelay?: number;
  timestamp?: number;
}

/** Every player key the plugin sends (anything else would be an unmapped section). */
const WIRE_PLAYER_KEYS = [
  'name',
  'accountHash',
  'accountType',
  'world',
  'worldTypes',
  'location',
  'locationTrail',
  'health',
  'prayerPoints',
  'spellbook',
  'stats',
  'inventory',
  'equipment',
];

function wire(name: FixtureName): WireBody {
  return fixtureJson<WireBody>(name);
}

function skillsOf(name: FixtureName): Record<string, WireSkill> {
  return wire(name).player!.stats!.skills;
}

function eventData<T>(name: FixtureName, index = 0): T {
  return wire(name).events![index]!.data as T;
}

/** Σ gePrice × quantity in 64-bit, independent of events/values. */
function gpSum(items: readonly WireItem[]): number {
  return Number(items.reduce((sum, i) => sum + BigInt(i.gePrice) * BigInt(i.quantity), 0n));
}

/** Real total level, Σ min(level, 99) (D-44). */
function realTotal(skills: Record<string, WireSkill>): number {
  return Object.values(skills).reduce((sum, s) => sum + Math.min(s.level, 99), 0);
}

function xpTotal(skills: Record<string, WireSkill>): number {
  return Object.values(skills).reduce((sum, s) => sum + s.xp, 0);
}

// ---------------------------------------------------------------------------------------------
// The pipeline, as packages/server runs it (minus the database)

const DEVICE = 'device-desktop';
const OTHER_DEVICE = 'device-laptop';
/** Between the plugin reading its clock and the hub receiving the body. */
const LATENCY_MS = 150;
/** Receive time for a body without a root timestamp (pair-request). */
const NO_TIMESTAMP_RECV = Date.UTC(2026, 8, 21, 13, 33, 20);

const EMPTY_STATE: PrevState = {
  sourceDeviceId: null,
  sourceTs: null,
  skills: null,
  equipment: null,
  gameState: null,
  world: null,
};

interface Step {
  payload: ParsedPayload;
  recv: Date;
  normalized: NormalizeResult;
  plan: SnapshotPlan;
  /** latest_state after the server applied the plan. */
  after: PrevState;
}

function recvFor(name: FixtureName): Date {
  return new Date((wire(name).timestamp ?? NO_TIMESTAMP_RECV) + LATENCY_MS);
}

/**
 * What the server writes to latest_state for a plan: keys missing from the patch keep their value
 * (D-18); a stale payload writes nothing, and doesn't regress game_state either (D-33).
 */
function applyPlan(prev: PrevState | null, plan: SnapshotPlan, state: string | null): PrevState {
  const before = prev ?? EMPTY_STATE;
  const patch = plan.latestPatch;
  if (patch === null) return before;
  return {
    sourceDeviceId: patch.sourceDeviceId ?? before.sourceDeviceId,
    sourceTs: patch.sourceTs ?? before.sourceTs,
    skills: patch.skills ?? before.skills,
    equipment: patch.equipment ?? before.equipment,
    gameState: state ?? before.gameState,
    world: patch.world ?? before.world,
  };
}

interface IngestOptions {
  prev?: PrevState | null;
  recv?: Date;
  deviceId?: string;
}

function ingestBody(body: string, recv: Date, opts: IngestOptions = {}): Step {
  const parsed = parsePayload(body);
  if (!parsed.ok) throw new Error(`parse failed: ${parsed.error}`);
  const { payload } = parsed;
  const prev = opts.prev ?? null;
  const normalized = normalizeEvents(payload.events, recv);
  const plan = planSnapshot(prev, payload, {
    recv,
    deviceId: opts.deviceId ?? DEVICE,
    payloadTs: payloadTime(payload.timestamp, recv),
  });
  return { payload, recv, normalized, plan, after: applyPlan(prev, plan, payload.state) };
}

function ingest(name: FixtureName, opts: IngestOptions = {}): Step {
  return ingestBody(fixtureBody(name), opts.recv ?? recvFor(name), opts);
}

/**
 * Payloads in ARRIVAL order, each planned against the latest_state the previous one left. Every
 * receive time is after its own timestamp and after the previous arrival. `devices[i]` defaults to
 * DEVICE.
 */
function replay<const N extends readonly FixtureName[]>(
  names: N,
  devices: readonly string[] = [],
): { [K in keyof N]: Step } {
  const steps: Step[] = [];
  let prev: PrevState | null = null;
  let lastRecv = Number.NEGATIVE_INFINITY;
  for (const [i, name] of names.entries()) {
    const recv = Math.max(recvFor(name).getTime(), lastRecv + 1);
    lastRecv = recv;
    const step = ingest(name, { prev, recv: new Date(recv), deviceId: devices[i] ?? DEVICE });
    steps.push(step);
    prev = step.after;
  }
  return steps as { [K in keyof N]: Step };
}

/** The dedupe key of an events row (plus account_id, which the server adds). */
function key(row: NormalizedEvent): string {
  return `${row.pluginEventId}#${row.subIndex}`;
}

const TYPE_COLUMNS = ['valueGp', 'itemId', 'npcId', 'skill', 'level', 'tier', 'points'] as const;

/** The type columns of a row, all null except `set`. */
function columns(set: Partial<Record<(typeof TYPE_COLUMNS)[number], unknown>>) {
  return Object.fromEntries(TYPE_COLUMNS.map((c) => [c, Object.hasOwn(set, c) ? set[c] : null]));
}

// ---------------------------------------------------------------------------------------------
// What each fixture should do (fixture README; handoff §7)

type Who = keyof typeof FIXTURE_ACCOUNTS;

const NAMES: Record<Who, string> = {
  zezima: 'Zezima',
  lynxTitan: 'Lynx Titan',
  ironMira: 'Iron Mira',
};

interface Expected {
  /** Whose snapshot it is; null without a usable identity (answered 200 and ignored, D-29). */
  who: Who | null;
  /** events.type of the stored rows, in order (a clientShutdown is not a row). */
  rows: string[];
  shutdown: ShutdownReason | null;
  /** worldTypes intersects the special set: only the world fields are written. */
  special: boolean;
}

const snapshot = (who: Who | null, special = false): Expected => ({
  who,
  rows: [],
  shutdown: null,
  special,
});
const withEvents = (who: Who, ...rows: string[]): Expected => ({
  who,
  rows,
  shutdown: null,
  special: false,
});
const lifecycle = (who: Who | null, shutdown: ShutdownReason): Expected => ({
  who,
  rows: [],
  shutdown,
  special: false,
});

const EXPECTED: Record<FixtureName, Expected> = {
  'disabled-login-screen': lifecycle(null, 'disabled'),
  'event-collectionlog-unresolved': withEvents('ironMira', 'collection_log'),
  'event-collectionlog': withEvents('ironMira', 'collection_log'),
  'event-combattask': withEvents('zezima', 'combat_task'),
  'event-death-dangerous': withEvents('ironMira', 'death'),
  'event-death-safe': withEvents('zezima', 'death'),
  'event-diary-repeat': withEvents('ironMira', 'achievement_diary', 'achievement_diary'),
  'event-levelup-multi': withEvents('ironMira', 'level_up', 'level_up', 'level_up'),
  'event-loot': withEvents('zezima', 'loot'),
  'event-pkloot': withEvents('lynxTitan', 'pk_loot'),
  'event-superior': withEvents('zezima', 'superior_spawn'),
  'event-unknown-type': withEvents('zezima', 'questComplete'),
  'hop-from-special-world-stale': snapshot('zezima', true),
  'login-partial-player': snapshot(null),
  'logout-client-start-no-player': lifecycle(null, 'logout'),
  logout: lifecycle('zezima', 'logout'),
  'pair-request': snapshot(null),
  'retry-duplicate-a': withEvents('zezima', 'loot'),
  'retry-duplicate-b': withEvents('zezima', 'loot'),
  'retry-overtaking-snapshot': snapshot('zezima'),
  shutdown: lifecycle('zezima', 'shutdown'),
  'snapshot-combat-burst-1': snapshot('zezima'),
  'snapshot-combat-burst-2': snapshot('zezima'),
  'snapshot-combat-burst-3': snapshot('zezima'),
  'snapshot-location-trail': snapshot('zezima'),
  'snapshot-no-sections': snapshot('zezima'),
  'snapshot-normal': snapshot('zezima'),
  'snapshot-world-hop': snapshot('zezima'),
  'special-world-seasonal': { ...withEvents('zezima', 'level_up'), special: true },
};

/** latest_state columns a first snapshot sets, built straight from the wire body (§7.1.13). */
function expectedPatch(w: WireBody, recv: Date, special: boolean): LatestStatePatch {
  const p = w.player ?? {};
  const world = p.world === undefined ? {} : { world: Number(p.world) };
  if (special) {
    return { ...world, worldTypes: p.worldTypes, specialWorld: true, worldUpdatedAt: recv };
  }
  return {
    sourceDeviceId: DEVICE,
    sourceTs: new Date(w.timestamp ?? recv.getTime()),
    ...world,
    ...(p.world !== undefined || p.worldTypes !== undefined ? { worldUpdatedAt: recv } : {}),
    ...(p.worldTypes && { worldTypes: p.worldTypes, specialWorld: false }),
    ...(p.health && {
      hpCurrent: p.health.current,
      hpMax: p.health.max,
      healthUpdatedAt: recv,
    }),
    ...(p.prayerPoints && {
      prayerCurrent: p.prayerPoints.current,
      prayerMax: p.prayerPoints.max,
      prayerUpdatedAt: recv,
    }),
    ...(p.spellbook && {
      spellbookId: p.spellbook.id,
      spellbook: p.spellbook.name,
      spellbookUpdatedAt: recv,
    }),
    ...(p.location && { location: p.location, locationUpdatedAt: recv }),
    ...(p.stats && { skills: p.stats.skills, skillsUpdatedAt: recv }),
    ...(p.inventory && { inventory: p.inventory.items, inventoryUpdatedAt: recv }),
    ...(p.equipment && { equipment: p.equipment.items, equipmentUpdatedAt: recv }),
  };
}

// ---------------------------------------------------------------------------------------------

describe('fixtures: the set', () => {
  it('FIXTURES lists every payload file on disk, once', () => {
    expect(payloadFilesOnDisk()).toEqual([...FIXTURES].sort());
    expect(new Set(FIXTURES).size).toBe(FIXTURES.length);
  });

  it('eventIds are unique across fixtures, except in the byte-identical resend', () => {
    const seen = new Map<string, FixtureName[]>();
    for (const name of FIXTURES) {
      for (const e of wire(name).events ?? []) {
        seen.set(e.eventId, [...(seen.get(e.eventId) ?? []), name]);
      }
    }
    expect([...seen.values()].filter((names) => names.length > 1)).toEqual([
      ['retry-duplicate-a', 'retry-duplicate-b'],
    ]);
  });
});

describe('fixtures: every payload through parse → normalize → plan', () => {
  it.each(FIXTURES)('%s: parses whole, with the expected identity', (name) => {
    const w = wire(name);
    const { payload } = ingest(name);
    // pair-request is the /pair body, not an ingest body: it has no `events`.
    expect(payload.skipped).toEqual({
      sections: [],
      events: 0,
      reasons: name === 'pair-request' ? ['events: missing'] : [],
    });
    expect(payload.events).toHaveLength(w.events?.length ?? 0);
    expect(payload.state).toBe(w.state ?? null);
    expect(payload.tickDelay).toBe(w.tickDelay ?? 0);
    expect(payload.timestamp).toBe(w.timestamp ?? null);

    const who = EXPECTED[name].who;
    if (who === null) {
      expect(payload.player?.accountHash).toBeUndefined();
      expect(payload.player?.name).toBeUndefined();
    } else {
      expect(payload.player?.accountHash).toBe(FIXTURE_ACCOUNTS[who]);
      expect(payload.player?.name).toBe(NAMES[who]);
    }
  });

  it.each(FIXTURES)('%s: stores the expected event rows, each the original event', (name) => {
    const expected = EXPECTED[name];
    const sent = wire(name).events ?? [];
    const { normalized } = ingest(name);

    expect(normalized.skipped).toBe(0);
    expect(normalized.events.map((row) => row.type)).toEqual(expected.rows);
    expect(normalized.shutdown?.reason ?? null).toBe(expected.shutdown);

    for (const row of normalized.events) {
      const source = sent.find((e) => e.eventId === row.pluginEventId);
      expect(source).toBeDefined();
      // Well inside [recv − 15 min, recv]: the plugin's time is kept.
      expect(row.occurredAt.getTime()).toBe(source!.timestamp);
      // The raw event (unknown fields and key order kept), not a zod output (D-31).
      expect(JSON.stringify(row.data)).toBe(JSON.stringify(source));
    }
    const keys = normalized.events.map(key);
    expect(new Set(keys).size).toBe(keys.length);

    const shutdownEvent = sent.find((e) => e.type === 'clientShutdown');
    expect(normalized.shutdown?.occurredAt.getTime()).toBe(shutdownEvent?.timestamp);
  });

  it.each(FIXTURES)('%s: plans the first snapshot from exactly the sections sent', (name) => {
    const w = wire(name);
    const p = w.player ?? {};
    const { special } = EXPECTED[name];
    const { plan, recv } = ingest(name);

    for (const k of Object.keys(p)) expect(WIRE_PLAYER_KEYS).toContain(k);
    expect(plan.stale).toBe(false);
    expect(plan.special).toBe(special);
    expect(plan.xpGuardTripped).toBe(false);
    expect(plan.xpGuardSkill).toBeNull();
    expect(plan.latestPatch).toStrictEqual(expectedPatch(w, recv, special));
    const inGame = w.state === 'LOGGED_IN';
    expect(plan.session).toEqual({
      open: inGame,
      extend: inGame,
      world: p.world === undefined ? null : Number(p.world),
    });

    const derived = !special;
    const skills = p.stats?.skills;
    expect(plan.xpWrites).toEqual(
      derived && skills
        ? [
            ...Object.entries(skills).map(([skill, v]) => ({ skill, xp: v.xp, level: v.level })),
            { skill: OVERALL, xp: xpTotal(skills), level: realTotal(skills) },
          ]
        : [],
    );
    expect(plan.equipmentChange).toEqual(derived && p.equipment ? p.equipment.items : null);
    const minute = recv.getTime() - (recv.getTime() % 60_000);
    expect(plan.locationSample).toEqual(
      derived && p.location
        ? {
            ts: new Date(minute),
            x: p.location.x,
            y: p.location.y,
            plane: p.location.plane,
            onBoat: p.location.isOnBoat ?? false,
            world: p.world === undefined ? null : Number(p.world),
          }
        : null,
    );
    expect(plan.wealth).toEqual(
      derived && p.inventory && p.equipment
        ? { day: '2026-09-21', value: gpSum(p.inventory.items) + gpSum(p.equipment.items) }
        : null,
    );
  });
});

describe('fixtures: stored events', () => {
  it('event-loot: value_gp is Σ gePrice × quantity over ALL items (Big bones included)', () => {
    const data = eventData<{ items: WireItem[]; totalValue: number }>('event-loot');
    expect(gpSum(data.items)).toBe(310 + 35_236_970);
    const [row] = ingest('event-loot').normalized.events;
    expect(row).toMatchObject({
      type: 'loot',
      subIndex: 0,
      ...columns({ valueGp: gpSum(data.items), itemId: 11828, npcId: 3162 }),
    });

    // Recomputed from the items, so it doesn't follow a different totalValue.
    const body = fixtureJson<{ events: { data: { totalValue: number } }[] }>('event-loot');
    body.events[0]!.data.totalValue = 1;
    const recomputed = ingestBody(JSON.stringify(body), recvFor('event-loot')).normalized;
    expect(recomputed.events[0]!.valueGp).toBe(gpSum(data.items));
  });

  it('event-pkloot: the 43,188 total of stacks each under 25k; no npcId for EVENT loot', () => {
    const data = eventData<{ items: WireItem[] }>('event-pkloot');
    expect(data.items.every((i) => i.gePrice * i.quantity < 25_000)).toBe(true);
    expect(gpSum(data.items)).toBe(43_188);
    const [row] = ingest('event-pkloot').normalized.events;
    expect(row).toMatchObject({
      type: 'pk_loot',
      ...columns({ valueGp: 43_188, itemId: 24598 }),
    });
  });

  it('event-death-safe: nothing lost → value_gp 0, although keptItems are worth something', () => {
    const data = eventData<{ keptItems: WireItem[]; lostItems: WireItem[] }>('event-death-safe');
    expect(data.lostItems).toEqual([]);
    expect(gpSum(data.keptItems)).toBeGreaterThan(0);
    const [row] = ingest('event-death-safe').normalized.events;
    expect(row).toMatchObject({ type: 'death', ...columns({ valueGp: 0 }) });
  });

  it('event-death-dangerous: value_gp is Σ lostItems only; no npc for a player killer', () => {
    const data = eventData<{ keptItems: WireItem[]; lostItems: WireItem[]; valueLost: number }>(
      'event-death-dangerous',
    );
    expect(gpSum(data.lostItems)).toBe(34_906);
    expect(data.valueLost).toBe(34_906);
    const [row] = ingest('event-death-dangerous').normalized.events;
    expect(row).toMatchObject({ type: 'death', ...columns({ valueGp: 34_906 }) });
  });

  it('event-levelup-multi: 3 rows at their original positions (HashMap order), Combat kept', () => {
    const eventId = wire('event-levelup-multi').events![0]!.eventId;
    const rows = ingest('event-levelup-multi').normalized.events;
    expect(rows.map((r) => ({ ...r, data: undefined, occurredAt: undefined }))).toEqual([
      {
        pluginEventId: eventId,
        subIndex: 0,
        type: 'level_up',
        ...columns({ skill: 'Hitpoints', level: 84 }),
      },
      {
        pluginEventId: eventId,
        subIndex: 1,
        type: 'level_up',
        ...columns({ skill: 'Combat', level: 101 }),
      },
      {
        pluginEventId: eventId,
        subIndex: 2,
        type: 'level_up',
        ...columns({ skill: 'Strength', level: 85 }),
      },
    ]);
  });

  it('event-combattask: tier grandmaster and 6 points from the untrimmed task name', () => {
    expect(eventData<{ taskName: string }>('event-combattask').taskName).toBe(
      ' No Pressure (6 points).',
    );
    const [row] = ingest('event-combattask').normalized.events;
    expect(row).toMatchObject({
      type: 'combat_task',
      ...columns({ tier: 'grandmaster', points: 6 }),
    });
  });

  it('event-collectionlog: item id and value; unresolved: item id -1 → null, value 0 (not null)', () => {
    const [resolved] = ingest('event-collectionlog').normalized.events;
    expect(resolved).toMatchObject(columns({ valueGp: 10_221_949, itemId: 12922 }));
    const [unresolved] = ingest('event-collectionlog-unresolved').normalized.events;
    expect(unresolved).toMatchObject(columns({ valueGp: 0, itemId: null }));
  });

  it('event-superior: the npc id', () => {
    const [row] = ingest('event-superior').normalized.events;
    expect(row).toMatchObject({ type: 'superior_spawn', ...columns({ npcId: 7411 }) });
  });

  it('event-diary-repeat: two identical diary events are two rows with different ids (§7.4)', () => {
    const sent = wire('event-diary-repeat').events!;
    expect(sent[0]!.data).toEqual(sent[1]!.data);
    const rows = ingest('event-diary-repeat').normalized.events;
    expect(rows.map((r) => r.pluginEventId)).toEqual(sent.map((e) => e.eventId));
    expect(rows[0]!.pluginEventId).not.toBe(rows[1]!.pluginEventId);
    for (const row of rows) {
      expect(row).toMatchObject({ type: 'achievement_diary', ...columns({ tier: 'easy' }) });
    }
    // Their own times, not that of the later send they rode along with.
    const sentAt = wire('event-diary-repeat').timestamp!;
    expect(rows.map((r) => sentAt - r.occurredAt.getTime())).toEqual([39_273, 21_427]);
  });

  it('event-unknown-type: stored under its raw type, with no columns and all its data', () => {
    const [row] = ingest('event-unknown-type').normalized.events;
    expect(row).toMatchObject({ type: 'questComplete', subIndex: 0, ...columns({}) });
    expect(row!.data).toEqual(wire('event-unknown-type').events![0]);
  });

  it.each([
    ['logout', 'logout'],
    ['logout-client-start-no-player', 'logout'],
    ['shutdown', 'shutdown'],
    ['disabled-login-screen', 'disabled'],
  ] as const)('%s: ends the session with reason %s instead of being stored', (name, reason) => {
    const { normalized } = ingest(name);
    expect(normalized).toEqual({
      events: [],
      shutdown: { reason, occurredAt: new Date(wire(name).events![0]!.timestamp) },
      skipped: 0,
    });
  });
});

describe('fixtures: players', () => {
  it('snapshot-normal, first seen: 24 skills as sent + Overall at the real total level 2372 (D-44)', () => {
    const skills = skillsOf('snapshot-normal');
    // Checked by hand from the data: 23 skills at 99+ count 99 each, Sailing counts its 95.
    expect(realTotal(skills)).toBe(23 * 99 + 95);
    expect(realTotal(skills)).toBe(2372);
    expect(Object.values(skills).reduce((sum, s) => sum + s.level, 0)).toBe(2459); // virtual
    expect(xpTotal(skills)).toBe(534_946_983);

    const { plan } = ingest('snapshot-normal');
    expect(plan.xpWrites).toHaveLength(25);
    expect(plan.xpWrites.map((w) => w.skill)).toEqual([...KNOWN_SKILLS, OVERALL]);
    expect(plan.xpWrites[0]).toEqual({ skill: 'Attack', xp: 34_512_847, level: 108 });
    expect(plan.xpWrites[24]).toEqual({ skill: OVERALL, xp: 534_946_983, level: 2372 });
  });

  it('snapshot-normal: carried wealth counts every per-slot inventory entry plus equipment', () => {
    const p = wire('snapshot-normal').player!;
    const anglerfish = p.inventory!.items.filter((i) => i.id === 13441);
    expect(anglerfish).toHaveLength(4);
    const { plan } = ingest('snapshot-normal');
    expect(plan.wealth).toEqual({ day: '2026-09-21', value: 84_474_944 });
    expect(plan.equipmentChange).toHaveLength(9);
    expect(plan.equipmentChange!.every((i) => i.equipmentSlot !== undefined)).toBe(true);
  });

  it('snapshot-no-sections: filtered sections are left out of the patch and keep their value (D-18)', () => {
    const [full, filtered] = replay(['snapshot-normal', 'snapshot-no-sections']);
    // Same device, same root timestamp: not stale.
    expect(filtered.payload.timestamp).toBe(full.payload.timestamp);
    expect(filtered.plan.stale).toBe(false);
    const patch = filtered.plan.latestPatch!;
    for (const k of [
      'inventory',
      'inventoryUpdatedAt',
      'equipment',
      'equipmentUpdatedAt',
      'location',
      'locationUpdatedAt',
    ]) {
      expect(patch).not.toHaveProperty(k);
    }
    expect(patch).toMatchObject({ skills: skillsOf('snapshot-no-sections'), hpCurrent: 99 });
    expect(filtered.plan).toMatchObject({
      xpWrites: [],
      equipmentChange: null,
      locationSample: null,
      wealth: null,
    });
    expect(filtered.after.equipment).toEqual(full.after.equipment);
  });

  it('snapshot-world-hop: SKILL_TOTAL is not special; same gear and XP → only the live fields change', () => {
    const [, hop] = replay(['snapshot-normal', 'snapshot-world-hop']);
    expect(hop.plan).toMatchObject({
      special: false,
      xpWrites: [],
      equipmentChange: null,
      session: { open: true, extend: true, world: 330 },
      latestPatch: { world: 330, worldTypes: ['MEMBERS', 'SKILL_TOTAL'], specialWorld: false },
    });
  });

  it('login-partial-player: a player with health only, no identity, and tickDelay 0 (PLUGIN-1)', () => {
    const { payload, plan, recv } = ingest('login-partial-player');
    expect(payload.player).toEqual({ health: { current: 99, max: 99 } });
    expect(payload.tickDelay).toBe(0);
    expect(plan.latestPatch).toEqual({
      sourceDeviceId: DEVICE,
      sourceTs: new Date(wire('login-partial-player').timestamp!),
      hpCurrent: 99,
      hpMax: 99,
      healthUpdatedAt: recv,
    });
  });

  it('disabled-login-screen: no player, no state, and a disabled shutdown', () => {
    const { payload, normalized, plan } = ingest('disabled-login-screen');
    expect(payload).toMatchObject({ player: null, state: null, tickDelay: 0 });
    expect(normalized.shutdown?.reason).toBe('disabled');
    expect(plan.session).toEqual({ open: false, extend: false, world: null });
  });

  it('logout-client-start-no-player: the start-up Logout has no player, but a LOGIN_SCREEN state', () => {
    const { payload, normalized, plan } = ingest('logout-client-start-no-player');
    expect(payload).toMatchObject({ player: null, state: 'LOGIN_SCREEN', events: [{}] });
    expect(normalized.shutdown?.reason).toBe('logout');
    expect(plan.session).toEqual({ open: false, extend: false, world: null });
  });
});

describe('fixtures: the resend (retry-duplicate-a/b)', () => {
  it('is byte-identical and normalizes to identical rows, even received 40 s later', () => {
    expect(fixtureBody('retry-duplicate-b')).toBe(fixtureBody('retry-duplicate-a'));
    const a = ingest('retry-duplicate-a');
    // OkHttp's 10 s read timeout + the 30 s backoff.
    const b = ingest('retry-duplicate-b', { recv: new Date(a.recv.getTime() + 40_000) });
    expect(b.normalized).toEqual(a.normalized);
    expect(b.normalized.events.map(key)).toEqual(['66bcfb05-60a0-44b5-89a1-7d4090e303c2#0']);
  });

  it('a → overtaking snapshot → b: b is stale, but its events keep their keys (§7.3, D-16)', () => {
    const a = ingest('retry-duplicate-a');
    const overtaking = ingest('retry-overtaking-snapshot', { prev: a.after });
    const b = ingest('retry-duplicate-b', {
      prev: overtaking.after,
      recv: new Date(a.recv.getTime() + 40_000),
    });
    expect(overtaking.plan.stale).toBe(false);
    expect(b.plan).toEqual({
      stale: true,
      special: false,
      xpWrites: [],
      xpGuardTripped: false,
      xpGuardSkill: null,
      equipmentChange: null,
      locationSample: null,
      wealth: null,
      session: { open: false, extend: true, world: 302 },
      latestPatch: null,
    });
    // latest_state keeps the newer snapshot; the events are still processed (ON CONFLICT DO NOTHING).
    expect(b.after).toEqual(overtaking.after);
    expect(b.normalized.events).toEqual(a.normalized.events);
  });
});

describe('fixtures: combat burst staleness (1 and 2 in one tick, 3 in the next)', () => {
  const burst1 = 'snapshot-combat-burst-1';
  const burst2 = 'snapshot-combat-burst-2';
  const burst3 = 'snapshot-combat-burst-3';
  const tsOf = (name: FixtureName) => new Date(wire(name).timestamp!);

  it('the data: 1 ms apart, then +602 ms with Attack +96 and Hitpoints +32 XP', () => {
    expect(wire(burst2).timestamp! - wire(burst1).timestamp!).toBe(1);
    expect(wire(burst3).timestamp! - wire(burst2).timestamp!).toBe(602);
    const [s1, s3] = [skillsOf(burst1), skillsOf(burst3)];
    const rose = Object.keys(s3).filter((k) => s3[k]!.xp !== s1[k]!.xp);
    expect(rose).toEqual(['Attack', 'Hitpoints']);
    expect(s3.Attack!.xp - s1.Attack!.xp).toBe(96);
    expect(s3.Hitpoints!.xp - s1.Hitpoints!.xp).toBe(32);
  });

  it('in order 1 → 2 → 3: none stale; 2 writes no XP, 3 only the skills that rose + Overall', () => {
    const [one, two, three] = replay([burst1, burst2, burst3]);
    expect([one.plan.stale, two.plan.stale, three.plan.stale]).toEqual([false, false, false]);
    expect(one.plan.xpWrites).toHaveLength(25);
    expect(two.plan.xpWrites).toEqual([]);
    expect(two.plan.latestPatch).toMatchObject({ prayerCurrent: 70, hpCurrent: 84 });
    const s3 = skillsOf(burst3);
    expect(three.plan.xpWrites).toEqual([
      { skill: 'Attack', ...s3.Attack },
      { skill: 'Hitpoints', ...s3.Hitpoints },
      { skill: OVERALL, xp: 534_947_111, level: realTotal(s3) },
    ]);
    expect(three.plan.locationSample).toMatchObject({ x: 3422, y: 3569, plane: 2 });
    expect(three.after.sourceTs).toEqual(tsOf(burst3));
  });

  it('out of order 2 → 1 → 3 on one device: 1 is stale and writes nothing', () => {
    const [two, one, three] = replay([burst2, burst1, burst3]);
    expect(two.plan.stale).toBe(false);
    expect(one.plan).toMatchObject({
      stale: true,
      latestPatch: null,
      xpWrites: [],
      equipmentChange: null,
      locationSample: null,
      wealth: null,
      session: { open: false, extend: true, world: 302 },
    });
    // burst-2's prayer 70 is not overwritten by burst-1's older 71.
    expect(one.after).toEqual(two.after);
    expect(one.after.sourceTs).toEqual(tsOf(burst2));
    expect(three.plan.stale).toBe(false);
    expect(three.plan.xpWrites.map((w) => w.skill)).toEqual(['Attack', 'Hitpoints', OVERALL]);
  });

  it('3 first: both same-tick snapshots are stale, and XP never goes back', () => {
    const [three, one, two] = replay([burst3, burst1, burst2]);
    expect([three.plan.stale, one.plan.stale, two.plan.stale]).toEqual([false, true, true]);
    expect(one.plan.xpGuardTripped).toBe(false);
    expect(two.after.skills).toEqual(skillsOf(burst3));
    expect(two.after.sourceTs).toEqual(tsOf(burst3));
  });

  it('from another device, an older snapshot is applied in arrival order (D-17)', () => {
    const [two, one, three] = replay([burst2, burst1, burst3], [DEVICE, OTHER_DEVICE, DEVICE]);
    expect(two.plan.stale).toBe(false);
    expect(one.plan.stale).toBe(false);
    expect(one.plan.latestPatch).toMatchObject({
      sourceDeviceId: OTHER_DEVICE,
      sourceTs: tsOf(burst1),
      prayerCurrent: 71,
    });
    // Back on the first device: judged against the other device's snapshot, so not stale either.
    expect(three.plan.stale).toBe(false);
    expect(three.plan.latestPatch).toMatchObject({ sourceDeviceId: DEVICE, prayerCurrent: 70 });
  });
});

describe('fixtures: special worlds (handoff §7.1.9, D-45)', () => {
  const worldOnly = (step: Step) => ({
    world: 485,
    worldTypes: ['MEMBERS', 'SEASONAL'],
    specialWorld: true,
    worldUpdatedAt: step.recv,
  });
  const nothingDerived = {
    special: true,
    stale: false,
    xpWrites: [],
    xpGuardTripped: false,
    xpGuardSkill: null,
    equipmentChange: null,
    locationSample: null,
    wealth: null,
  };

  it('special-world-seasonal: only the world fields; the lower league XP trips nothing', () => {
    const [main, league] = replay(['snapshot-normal', 'special-world-seasonal']);
    expect(xpTotal(skillsOf('special-world-seasonal'))).toBeLessThan(
      xpTotal(skillsOf('snapshot-normal')),
    );
    expect(league.plan).toMatchObject({
      ...nothingDerived,
      session: { open: true, extend: true, world: 485 },
    });
    expect(league.plan.latestPatch).toEqual(worldOnly(league));
    expect(league.after.skills).toEqual(main.after.skills);
    // Its levelUp is still normalized (the server stores it with special_world = true).
    expect(league.normalized.events).toMatchObject([
      { type: 'level_up', subIndex: 0, skill: 'Woodcutting', level: 41 },
    ]);
  });

  it('hop-from-special-world-stale: special by the payload worldTypes, though the live world is normal (PLUGIN-8)', () => {
    const [main, , hop, back] = replay([
      'snapshot-normal',
      'special-world-seasonal',
      'hop-from-special-world-stale',
      'event-unknown-type',
    ]);
    expect(hop.payload.player).toMatchObject({ world: 485, health: { current: 99, max: 99 } });
    expect(hop.plan).toMatchObject({
      ...nothingDerived,
      session: { open: true, extend: true, world: 485 },
    });
    expect(hop.plan.latestPatch).toEqual(worldOnly(hop));
    expect(hop.after.skills).toEqual(main.after.skills);
    // The next normal payload clears the flag, and the main's XP is where it was.
    expect(back.plan).toMatchObject({ special: false, xpWrites: [], xpGuardTripped: false });
    expect(back.plan.latestPatch).toMatchObject({
      world: 302,
      worldTypes: ['MEMBERS'],
      specialWorld: false,
    });
  });

  it('the XP guard is the backstop: the same hop without SEASONAL trips it on the main (D-24)', () => {
    const main = ingest('snapshot-normal');
    const body = fixtureJson<WireBody>('hop-from-special-world-stale');
    body.player!.worldTypes = ['MEMBERS'];
    const hop = ingestBody(JSON.stringify(body), recvFor('hop-from-special-world-stale'), {
      prev: main.after,
    });
    expect(hop.plan).toMatchObject({
      special: false,
      xpWrites: [],
      xpGuardTripped: true,
      xpGuardSkill: 'Attack',
    });
    expect(hop.plan.latestPatch).not.toHaveProperty('skills');
    expect(hop.plan.latestPatch).not.toHaveProperty('skillsUpdatedAt');
  });
});

describe('fixtures: Iron Mira, one device in time order', () => {
  it('the level-up snapshot writes exactly the levels the levelUp event reports, plus Overall', () => {
    const [death, levelUp, ...later] = replay([
      'event-death-dangerous',
      'event-levelup-multi',
      'event-collectionlog',
      'event-collectionlog-unresolved',
      'event-diary-repeat',
    ]);
    for (const step of [death, levelUp, ...later]) {
      expect(step.plan).toMatchObject({ stale: false, special: false, xpGuardTripped: false });
    }
    const bySkill = (a: { skill: string | null }, b: { skill: string | null }) =>
      (a.skill ?? '').localeCompare(b.skill ?? '');
    const reported = levelUp.normalized.events
      .filter((row) => row.skill !== 'Combat')
      .map(({ skill, level }) => ({ skill, level }))
      .sort(bySkill);
    const written = levelUp.plan.xpWrites
      .filter((w) => w.skill !== OVERALL)
      .map(({ skill, level }) => ({ skill, level }))
      .sort(bySkill);
    expect(written).toEqual(reported);
    expect(written).toEqual([
      { skill: 'Hitpoints', level: 84 },
      { skill: 'Strength', level: 85 },
    ]);
    expect(levelUp.plan.xpWrites.at(-1)).toEqual({
      skill: OVERALL,
      xp: xpTotal(skillsOf('event-levelup-multi')),
      level: realTotal(skillsOf('event-death-dangerous')) + 2,
    });
    for (const step of later) expect(step.plan.xpWrites).toEqual([]);
  });
});
