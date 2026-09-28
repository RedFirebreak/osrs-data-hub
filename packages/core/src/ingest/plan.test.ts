import { fixtureJson, type FixtureName } from '@hub/fixtures';
import { describe, expect, it } from 'vitest';
import type {
  ItemData,
  Location,
  Meter,
  ParsedPayload,
  PlayerSnapshot,
  SkillValue,
} from '../payload/types';
import { KNOWN_SKILLS } from '../skills';
import { planSnapshot } from './plan';
import type { LatestStatePatch, PrevState, SnapshotContext } from './types';

/** The wire shape of a fixture body (strings where the plugin sends strings). */
interface WireBody {
  player?: {
    name?: string;
    accountHash?: string;
    accountType?: string;
    world?: string;
    worldTypes?: string[];
    location?: Location;
    health?: Meter;
    prayerPoints?: Meter;
    spellbook?: { id: number; name: string };
    stats?: { skills: Record<string, SkillValue> };
    inventory?: { items: ItemData[] };
    equipment?: { items: ItemData[] };
  };
  state?: string;
  tickDelay: number;
  timestamp: number;
}

/** What parsePayload would return for a fixture, mapped by hand. */
function fromFixture(name: FixtureName): ParsedPayload {
  const body = fixtureJson<WireBody>(name);
  const p = body.player;
  let player: PlayerSnapshot | null = null;
  if (p !== undefined) {
    player = {};
    if (p.name !== undefined) player.name = p.name;
    if (p.accountHash !== undefined) player.accountHash = p.accountHash;
    if (p.accountType !== undefined) player.accountType = Number(p.accountType);
    if (p.world !== undefined) player.world = Number(p.world);
    if (p.worldTypes !== undefined) player.worldTypes = p.worldTypes;
    if (p.location !== undefined) player.location = p.location;
    if (p.health !== undefined) player.health = p.health;
    if (p.prayerPoints !== undefined) player.prayer = p.prayerPoints;
    if (p.spellbook !== undefined) player.spellbook = p.spellbook;
    if (p.stats !== undefined) player.skills = p.stats.skills;
    if (p.inventory !== undefined) player.inventory = p.inventory.items;
    if (p.equipment !== undefined) player.equipment = p.equipment.items;
  }
  return {
    player,
    events: [],
    state: body.state ?? null,
    tickDelay: body.tickDelay,
    timestamp: body.timestamp,
    skipped: { sections: [], events: 0, reasons: [] },
  };
}

function payload(player: PlayerSnapshot | null, state: string | null = 'LOGGED_IN'): ParsedPayload {
  return {
    player,
    events: [],
    state,
    tickDelay: 100,
    timestamp: null,
    skipped: { sections: [], events: 0, reasons: [] },
  };
}

const DEVICE = 'device-a';
const OTHER_DEVICE = 'device-b';

/** After every fixture timestamp: the time of hand-built payloads (timestamp null). */
const HAND_BUILT_TS = Date.parse('2026-09-22T12:00:00.000Z');

/** Context for a payload received `lagMs` after it was built. */
function ctxFor(p: ParsedPayload, lagMs = 1500, deviceId = DEVICE): SnapshotContext {
  const ts = p.timestamp ?? HAND_BUILT_TS;
  return { recv: new Date(ts + lagMs), deviceId, payloadTs: new Date(ts) };
}

/** What the caller would read back from latest_state after applying a plan's patch. */
function applyPatch(prev: PrevState | null, patch: LatestStatePatch | null): PrevState {
  const base: PrevState = prev ?? {
    sourceDeviceId: null,
    sourceTs: null,
    skills: null,
    equipment: null,
    gameState: null,
    world: null,
  };
  if (patch === null) return base;
  return {
    ...base,
    sourceDeviceId: patch.sourceDeviceId ?? base.sourceDeviceId,
    sourceTs: patch.sourceTs ?? base.sourceTs,
    skills: patch.skills ?? base.skills,
    equipment: patch.equipment ?? base.equipment,
    world: patch.world ?? base.world,
  };
}

/** latest_state after the first snapshot-normal from DEVICE. */
function prevAfterNormal(): PrevState {
  const p = fromFixture('snapshot-normal');
  return applyPatch(null, planSnapshot(null, p, ctxFor(p)).latestPatch);
}

function skillsOf(name: FixtureName): Record<string, SkillValue> {
  return fromFixture(name).player!.skills!;
}

const UPDATED_AT_KEYS = [
  'worldUpdatedAt',
  'healthUpdatedAt',
  'prayerUpdatedAt',
  'spellbookUpdatedAt',
  'locationUpdatedAt',
  'skillsUpdatedAt',
  'inventoryUpdatedAt',
  'equipmentUpdatedAt',
] as const;

describe('planSnapshot: first snapshot', () => {
  const p = fromFixture('snapshot-normal');
  const ctx = ctxFor(p);
  const plan = planSnapshot(null, p, ctx);
  const player = p.player!;

  it('is neither stale nor special', () => {
    expect(plan.stale).toBe(false);
    expect(plan.special).toBe(false);
    expect(plan.xpGuardTripped).toBe(false);
    expect(plan.xpGuardSkill).toBeNull();
  });

  it('writes all 24 skills as sent plus Overall with the REAL total level (D-44)', () => {
    expect(plan.xpWrites).toHaveLength(25);
    const bySkill = new Map(plan.xpWrites.map((w) => [w.skill, w]));
    for (const skill of KNOWN_SKILLS) {
      expect(bySkill.get(skill)).toEqual({ skill, ...player.skills![skill] });
    }
    // Virtual levels are kept per skill: Attack is 108 at 34.5M XP.
    expect(bySkill.get('Attack')).toEqual({ skill: 'Attack', xp: 34_512_847, level: 108 });
    // Σ min(level, 99) = 2372, not the virtual sum 2459 (PLUGIN-9).
    expect(bySkill.get('Overall')).toEqual({ skill: 'Overall', xp: 534_946_983, level: 2372 });
  });

  it('patches every section with its own updated-at, plus the source device and time', () => {
    expect(plan.latestPatch).toEqual({
      sourceDeviceId: DEVICE,
      sourceTs: ctx.payloadTs,
      world: 302,
      worldTypes: ['MEMBERS'],
      specialWorld: false,
      worldUpdatedAt: ctx.recv,
      hpCurrent: 99,
      hpMax: 99,
      healthUpdatedAt: ctx.recv,
      prayerCurrent: 99,
      prayerMax: 99,
      prayerUpdatedAt: ctx.recv,
      spellbookId: 2,
      spellbook: 'lunar',
      spellbookUpdatedAt: ctx.recv,
      location: { x: 3164, y: 3487, plane: 0, isOnBoat: false },
      locationUpdatedAt: ctx.recv,
      skills: player.skills,
      skillsUpdatedAt: ctx.recv,
      inventory: player.inventory,
      inventoryUpdatedAt: ctx.recv,
      equipment: player.equipment,
      equipmentUpdatedAt: ctx.recv,
    });
  });

  it('records the equipment as a change (first seen)', () => {
    expect(plan.equipmentChange).toEqual(player.equipment);
  });

  it('samples the location in the recv minute', () => {
    expect(plan.locationSample).toEqual({
      ts: new Date(Math.floor(ctx.recv.getTime() / 60_000) * 60_000),
      x: 3164,
      y: 3487,
      plane: 0,
      onBoat: false,
      world: 302,
    });
  });

  it('computes carried wealth from per-slot inventory entries plus equipment', () => {
    // Inventory 18,502,335 (4 Anglerfish entries, 2 Prayer potion entries) + equipment 65,972,609.
    expect(plan.wealth).toEqual({ day: '2026-09-21', value: 84_474_944 });
  });

  it('opens and extends a session on LOGGED_IN', () => {
    expect(plan.session).toEqual({ open: true, extend: true, world: 302 });
  });

  it('treats prev with no skills or equipment yet like a first snapshot', () => {
    const prev: PrevState = {
      sourceDeviceId: OTHER_DEVICE,
      sourceTs: new Date(0),
      skills: null,
      equipment: null,
      gameState: 'LOGGED_IN',
      world: 301,
    };
    const again = planSnapshot(prev, p, ctx);
    expect(again.xpWrites).toHaveLength(25);
    expect(again.equipmentChange).toEqual(player.equipment);
  });
});

describe('planSnapshot: XP diffing', () => {
  it('writes nothing for an unchanged snapshot', () => {
    const prev = prevAfterNormal();
    const p = fromFixture('snapshot-normal');
    const plan = planSnapshot(prev, p, ctxFor(p, 60_000));
    expect(plan.xpWrites).toEqual([]);
    expect(plan.equipmentChange).toBeNull();
    expect(plan.xpGuardTripped).toBe(false);
    // The rest of latest_state is still refreshed.
    expect(plan.latestPatch?.skills).toEqual(p.player!.skills);
    expect(plan.locationSample).not.toBeNull();
    expect(plan.wealth).not.toBeNull();
  });

  it('writes only the changed skills plus Overall (combat burst 2 → 3)', () => {
    const b2 = fromFixture('snapshot-combat-burst-2');
    const prev = applyPatch(null, planSnapshot(null, b2, ctxFor(b2)).latestPatch);
    const b3 = fromFixture('snapshot-combat-burst-3');
    const plan = planSnapshot(prev, b3, ctxFor(b3));
    expect(plan.xpWrites).toEqual([
      { skill: 'Attack', xp: 34_512_943, level: 108 },
      { skill: 'Hitpoints', xp: 61_930_787, level: 114 },
      { skill: 'Overall', xp: 534_947_111, level: 2372 },
    ]);
  });

  it('writes a single changed skill and Overall', () => {
    const prev = prevAfterNormal();
    const skills = { ...skillsOf('snapshot-normal'), Cooking: { xp: 13_034_531, level: 99 } };
    const plan = planSnapshot(prev, payload({ skills }), ctxFor(payload(null), 5000));
    expect(plan.xpWrites).toEqual([
      { skill: 'Cooking', xp: 13_034_531, level: 99 },
      { skill: 'Overall', xp: 534_946_983 + 100, level: 2372 },
    ]);
  });

  it('writes a skill the previous state lacks (a new skill) and merges it into Overall', () => {
    const prev = prevAfterNormal();
    const skills = { ...skillsOf('snapshot-normal'), Necromancy: { xp: 1000, level: 9 } };
    const plan = planSnapshot(prev, payload({ skills }), ctxFor(payload(null), 5000));
    expect(plan.xpWrites).toEqual([
      { skill: 'Necromancy', xp: 1000, level: 9 },
      { skill: 'Overall', xp: 534_946_983 + 1000, level: 2372 + 9 },
    ]);
  });

  it('keeps skills missing from the payload in Overall (merged with prev) and writes nothing', () => {
    const prev = prevAfterNormal();
    const { Attack: _dropped, ...rest } = skillsOf('snapshot-normal');
    const plan = planSnapshot(prev, payload({ skills: rest }), ctxFor(payload(null), 5000));
    expect(plan.xpWrites).toEqual([]);
    // skills is stored as sent.
    expect(plan.latestPatch?.skills).toEqual(rest);
  });

  it('writes no Overall for an empty skills map without prev', () => {
    const p = payload({ skills: {} });
    expect(planSnapshot(null, p, ctxFor(p)).xpWrites).toEqual([]);
  });

  it('ignores an "Overall" entry in the payload (Overall is always derived)', () => {
    const prev = prevAfterNormal();
    const skills = { ...skillsOf('snapshot-normal'), Overall: { xp: 1, level: 1 } };
    const plan = planSnapshot(prev, payload({ skills }), ctxFor(payload(null), 5000));
    expect(plan.xpWrites).toEqual([]);
  });

  it('trips the guard on an XP drop: the snapshot is treated like a special-world one (D-24)', () => {
    const prev = prevAfterNormal();
    const base = skillsOf('snapshot-normal');
    const skills = {
      ...base,
      Cooking: { xp: base.Cooking!.xp + 500, level: 99 },
      Fishing: { xp: base.Fishing!.xp - 1, level: 103 },
      Mining: { xp: 0, level: 1 },
    };
    const p = payload({ skills, health: { current: 50, max: 99 } });
    const ctx = ctxFor(p, 5000);
    const plan = planSnapshot(prev, p, ctx);
    expect(plan.xpGuardTripped).toBe(true);
    expect(plan.xpGuardSkill).toBe('Fishing');
    expect(plan.xpWrites).toEqual([]);
    // Probably another character or an unknown world type (PLUGIN-8): nothing but live world fields,
    // and the source device/time stay as they were so the next normal snapshot is judged against them.
    expect(plan.latestPatch).toEqual({});
    expect(plan.equipmentChange).toBeNull();
    expect(plan.locationSample).toBeNull();
    expect(plan.wealth).toBeNull();
  });

  it('keeps world fields from a guarded snapshot', () => {
    const prev = prevAfterNormal();
    const base = skillsOf('snapshot-normal');
    const p = payload({
      skills: { ...base, Fishing: { xp: base.Fishing!.xp - 1, level: 103 } },
      world: 330,
      worldTypes: ['MEMBERS'],
      inventory: [],
      equipment: [],
      location: { x: 1, y: 2, plane: 0 },
    });
    const ctx = ctxFor(p, 5000);
    const plan = planSnapshot(prev, p, ctx);
    expect(plan.xpGuardTripped).toBe(true);
    expect(plan.latestPatch).toEqual({
      world: 330,
      worldTypes: ['MEMBERS'],
      worldUpdatedAt: ctx.recv,
    });
    expect(plan.wealth).toBeNull();
    expect(plan.locationSample).toBeNull();
    expect(plan.equipmentChange).toBeNull();
  });

  it('catches league stats labelled as a normal world (unknown special world type)', () => {
    const prev = prevAfterNormal();
    const hop = fromFixture('hop-from-special-world-stale');
    hop.player!.worldTypes = ['MEMBERS'];
    const plan = planSnapshot(prev, hop, ctxFor(hop));
    expect(plan.special).toBe(false);
    expect(plan.xpGuardTripped).toBe(true);
    expect(plan.xpGuardSkill).toBe('Attack');
    expect(plan.xpWrites).toEqual([]);
    expect(plan.latestPatch).not.toHaveProperty('skills');
  });
});

describe('planSnapshot: staleness (per device, D-17)', () => {
  it('a resend older than the last snapshot from the same device is stale: nothing but session', () => {
    const overtaking = fromFixture('retry-overtaking-snapshot');
    const prev = applyPatch(null, planSnapshot(null, overtaking, ctxFor(overtaking)).latestPatch);
    const resend = fromFixture('retry-duplicate-b');
    expect(resend.timestamp!).toBeLessThan(overtaking.timestamp!);
    const plan = planSnapshot(prev, resend, ctxFor(resend, 40_000));
    expect(plan).toEqual({
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
  });

  it('a stale payload outside the game only reports no session extension', () => {
    const prev = prevAfterNormal();
    const p = fromFixture('snapshot-normal');
    p.state = 'LOGIN_SCREEN';
    const plan = planSnapshot(prev, p, {
      recv: new Date(),
      deviceId: DEVICE,
      payloadTs: new Date(p.timestamp! - 1),
    });
    expect(plan.stale).toBe(true);
    expect(plan.session).toEqual({ open: false, extend: false, world: 302 });
  });

  it('the same time from the same device is not stale', () => {
    const prev = prevAfterNormal();
    const p = fromFixture('snapshot-normal');
    const plan = planSnapshot(prev, p, ctxFor(p, 9000));
    expect(plan.stale).toBe(false);
    expect(plan.latestPatch).not.toBeNull();
  });

  it('an older payload from ANOTHER device is applied (clocks differ between PCs)', () => {
    const prev = prevAfterNormal();
    const p = fromFixture('snapshot-combat-burst-3');
    const ctx: SnapshotContext = {
      recv: new Date(prev.sourceTs!.getTime() + 60_000),
      deviceId: OTHER_DEVICE,
      payloadTs: new Date(prev.sourceTs!.getTime() - 86_400_000),
    };
    const plan = planSnapshot(prev, p, ctx);
    expect(plan.stale).toBe(false);
    expect(plan.latestPatch).toMatchObject({
      sourceDeviceId: OTHER_DEVICE,
      sourceTs: ctx.payloadTs,
    });
    expect(plan.xpWrites.map((w) => w.skill)).toEqual(['Attack', 'Hitpoints', 'Overall']);
    expect(plan.session.open).toBe(true);
  });
});

describe('planSnapshot: special worlds', () => {
  it('SEASONAL: only the world fields, no derived writes, no XP guard on lower league XP', () => {
    const prev = prevAfterNormal();
    const p = fromFixture('special-world-seasonal');
    const ctx = ctxFor(p);
    const plan = planSnapshot(prev, p, ctx);
    expect(plan.special).toBe(true);
    expect(plan.stale).toBe(false);
    expect(plan.latestPatch).toStrictEqual({
      specialWorld: true,
      worldUpdatedAt: ctx.recv,
      world: 485,
      worldTypes: ['MEMBERS', 'SEASONAL'],
    });
    expect(plan.xpWrites).toEqual([]);
    expect(plan.xpGuardTripped).toBe(false);
    expect(plan.xpGuardSkill).toBeNull();
    expect(plan.equipmentChange).toBeNull();
    expect(plan.locationSample).toBeNull();
    expect(plan.wealth).toBeNull();
    // Sessions are still tracked on special worlds (D-45).
    expect(plan.session).toEqual({ open: true, extend: true, world: 485 });
  });

  it('the stale hop off a special world is classified by the payload worldTypes (PLUGIN-8)', () => {
    const prev = prevAfterNormal();
    const p = fromFixture('hop-from-special-world-stale');
    const plan = planSnapshot(prev, p, ctxFor(p));
    expect(plan.special).toBe(true);
    expect(Object.keys(plan.latestPatch!).sort()).toEqual([
      'specialWorld',
      'world',
      'worldTypes',
      'worldUpdatedAt',
    ]);
    expect(plan.xpWrites).toEqual([]);
  });

  it.each([
    'DEADMAN',
    'TOURNAMENT_WORLD',
    'BETA_WORLD',
    'QUEST_SPEEDRUNNING',
    'NOSAVE_MODE',
    'PVP_ARENA',
  ])('%s is special too', (type) => {
    const plan = planSnapshot(
      null,
      payload({ world: 345, worldTypes: [type], skills: { Attack: { xp: 1, level: 1 } } }),
      ctxFor(payload(null)),
    );
    expect(plan.special).toBe(true);
    expect(plan.xpWrites).toEqual([]);
  });

  it('a special payload without a world number patches only the special flag and world types', () => {
    const p = payload({ worldTypes: ['SEASONAL'] }, 'LOADING');
    const ctx = ctxFor(p);
    const plan = planSnapshot(null, p, ctx);
    expect(plan.latestPatch).toStrictEqual({
      specialWorld: true,
      worldUpdatedAt: ctx.recv,
      worldTypes: ['SEASONAL'],
    });
    expect(plan.session).toEqual({ open: false, extend: true, world: null });
  });

  it('a stale special payload is stale first', () => {
    const prev = prevAfterNormal();
    const p = fromFixture('special-world-seasonal');
    const plan = planSnapshot(prev, p, {
      recv: new Date(),
      deviceId: DEVICE,
      payloadTs: new Date(0),
    });
    expect(plan.stale).toBe(true);
    expect(plan.special).toBe(true);
    expect(plan.latestPatch).toBeNull();
    expect(plan.session.open).toBe(false);
  });
});

describe('planSnapshot: missing sections (D-18)', () => {
  it('a filtered snapshot leaves location, inventory and equipment out of the patch', () => {
    const prev = prevAfterNormal();
    const p = fromFixture('snapshot-no-sections');
    const plan = planSnapshot(prev, p, ctxFor(p, 70_000));
    const patch = plan.latestPatch!;
    for (const key of [
      'location',
      'locationUpdatedAt',
      'inventory',
      'inventoryUpdatedAt',
      'equipment',
      'equipmentUpdatedAt',
    ]) {
      expect(patch).not.toHaveProperty(key);
    }
    expect(patch).toHaveProperty('skills');
    expect(patch).toHaveProperty('hpCurrent');
    expect(plan.locationSample).toBeNull();
    expect(plan.wealth).toBeNull();
    expect(plan.equipmentChange).toBeNull();
  });

  it('a partial player (login stat sync) patches only health and the source', () => {
    const p = fromFixture('login-partial-player');
    const ctx = ctxFor(p);
    const plan = planSnapshot(null, p, ctx);
    expect(plan.latestPatch).toStrictEqual({
      sourceDeviceId: DEVICE,
      sourceTs: ctx.payloadTs,
      hpCurrent: p.player!.health!.current,
      hpMax: p.player!.health!.max,
      healthUpdatedAt: ctx.recv,
    });
    expect(plan.xpWrites).toEqual([]);
    expect(plan.session).toEqual({ open: true, extend: true, world: null });
  });

  it('never writes undefined keys', () => {
    const p = payload({ name: 'Zezima' });
    const patch = planSnapshot(null, p, ctxFor(p)).latestPatch!;
    expect(Object.keys(patch).sort()).toEqual(['sourceDeviceId', 'sourceTs']);
    for (const key of UPDATED_AT_KEYS) expect(patch).not.toHaveProperty(key);
  });

  it('a payload without a player is planned as a player with no sections', () => {
    const p = fromFixture('logout-client-start-no-player');
    const ctx = ctxFor(p);
    const plan = planSnapshot(null, p, ctx);
    expect(plan.latestPatch).toStrictEqual({ sourceDeviceId: DEVICE, sourceTs: ctx.payloadTs });
    expect(plan.xpWrites).toEqual([]);
    expect(plan.session).toEqual({ open: false, extend: false, world: null });
  });

  it('world and worldTypes are separate sections', () => {
    const onlyWorld = payload({ world: 330 });
    const a = planSnapshot(null, onlyWorld, ctxFor(onlyWorld)).latestPatch!;
    expect(a).toMatchObject({ world: 330 });
    expect(a).toHaveProperty('worldUpdatedAt');
    expect(a).not.toHaveProperty('worldTypes');
    expect(a).not.toHaveProperty('specialWorld');

    const onlyTypes = payload({ worldTypes: [] });
    const b = planSnapshot(null, onlyTypes, ctxFor(onlyTypes)).latestPatch!;
    expect(b).toMatchObject({ worldTypes: [], specialWorld: false });
    expect(b).toHaveProperty('worldUpdatedAt');
    expect(b).not.toHaveProperty('world');
  });

  it('prayer and spellbook map to their columns', () => {
    const p = payload({ prayer: { current: 52, max: 70 }, spellbook: { id: 1, name: 'ancient' } });
    const ctx = ctxFor(p);
    expect(planSnapshot(null, p, ctx).latestPatch).toStrictEqual({
      sourceDeviceId: DEVICE,
      sourceTs: ctx.payloadTs,
      prayerCurrent: 52,
      prayerMax: 70,
      prayerUpdatedAt: ctx.recv,
      spellbookId: 1,
      spellbook: 'ancient',
      spellbookUpdatedAt: ctx.recv,
    });
  });
});

describe('planSnapshot: equipment changes', () => {
  const bolts: ItemData = {
    name: 'Runite bolts',
    id: 9144,
    gePrice: 76,
    quantity: 500,
    equipmentSlot: 'AMMO',
  };
  const bow: ItemData = {
    name: 'Rune crossbow',
    id: 9185,
    gePrice: 9232,
    quantity: 1,
    equipmentSlot: 'WEAPON',
  };
  const prevWith = (equipment: ItemData[] | null): PrevState => ({
    sourceDeviceId: DEVICE,
    sourceTs: new Date(0),
    skills: null,
    equipment,
    gameState: 'LOGGED_IN',
    world: 302,
  });
  const change = (before: ItemData[] | null, after: ItemData[]) => {
    const p = payload({ equipment: after });
    return planSnapshot(prevWith(before), p, ctxFor(p)).equipmentChange;
  };

  it('ammo being used up (a quantity change) is not an equipment change', () => {
    expect(change([bow, bolts], [bow, { ...bolts, quantity: 499 }])).toBeNull();
  });

  it('a different item id in a slot is a change', () => {
    const dragonBolts = { ...bolts, id: 21905, name: 'Dragon bolts' };
    expect(change([bow, bolts], [bow, dragonBolts])).toEqual([bow, dragonBolts]);
  });

  it('adding or removing an item is a change', () => {
    expect(change([bow], [bow, bolts])).toEqual([bow, bolts]);
    expect(change([bow, bolts], [bow])).toEqual([bow]);
    expect(change([bow], [])).toEqual([]);
  });

  it('the same item moved to another slot is a change; the list order alone is not', () => {
    expect(change([bow], [{ ...bow, equipmentSlot: 'SHIELD' }])).not.toBeNull();
    expect(change([bow, bolts], [bolts, bow])).toBeNull();
  });

  it('items without a slot are keyed by their index', () => {
    const a = { id: 1, gePrice: 0, quantity: 1 };
    const b = { id: 2, gePrice: 0, quantity: 1 };
    expect(change([a, b], [a, b])).toBeNull();
    expect(change([a, b], [b, a])).toEqual([b, a]);
  });

  it('first seen (no previous equipment), even empty, is a change', () => {
    expect(change(null, [])).toEqual([]);
    expect(change(null, [bow])).toEqual([bow]);
  });

  it('unchanged empty equipment is not a change', () => {
    expect(change([], [])).toBeNull();
  });

  it('the world-hop fixture keeps the same gear: no change', () => {
    const prev = prevAfterNormal();
    const hop = fromFixture('snapshot-world-hop');
    expect(planSnapshot(prev, hop, ctxFor(hop)).equipmentChange).toBeNull();
  });
});

describe('planSnapshot: wealth', () => {
  const inventory: ItemData[] = [
    { name: 'Shark', id: 385, gePrice: 963, quantity: 1 },
    { name: 'Shark', id: 385, gePrice: 963, quantity: 1 },
    { name: 'Coins', id: 995, gePrice: 1, quantity: 25_000 },
  ];
  const equipment: ItemData[] = [
    { name: 'Abyssal whip', id: 4151, gePrice: 809_574, quantity: 1, equipmentSlot: 'WEAPON' },
  ];

  it('needs both inventory and equipment, and sums per-slot entries', () => {
    const p = payload({ inventory, equipment });
    const ctx = { ...ctxFor(p), recv: new Date('2026-09-21T23:59:59.999Z') };
    expect(planSnapshot(null, p, ctx).wealth).toEqual({
      day: '2026-09-21',
      value: 963 * 2 + 25_000 + 809_574,
    });
    const q = payload({ inventory });
    expect(planSnapshot(null, q, ctxFor(q)).wealth).toBeNull();
    const r = payload({ equipment });
    expect(planSnapshot(null, r, ctxFor(r)).wealth).toBeNull();
  });

  it('empty sections are present sections: wealth 0', () => {
    const p = payload({ inventory: [], equipment: [] });
    expect(planSnapshot(null, p, ctxFor(p)).wealth?.value).toBe(0);
  });

  it('uses the UTC day of recv, not of the payload time', () => {
    const p = payload({ inventory, equipment });
    const ctx: SnapshotContext = {
      recv: new Date('2026-09-22T00:00:01.000Z'),
      deviceId: DEVICE,
      payloadTs: new Date('2026-09-21T23:59:50.000Z'),
    };
    expect(planSnapshot(null, p, ctx).wealth?.day).toBe('2026-09-22');
  });
});

describe('planSnapshot: location sample', () => {
  const loc = (location: Location, world?: number) =>
    payload(world === undefined ? { location } : { location, world });
  const recv = new Date('2026-09-21T13:40:59.999Z');
  const ctx: SnapshotContext = {
    recv,
    deviceId: DEVICE,
    payloadTs: new Date('2026-09-21T13:40:58.000Z'),
  };

  it('is floored to the minute of recv', () => {
    const sample = planSnapshot(null, loc({ x: 1, y: 2, plane: 3 }, 302), ctx).locationSample;
    expect(sample).toEqual({
      ts: new Date('2026-09-21T13:40:00.000Z'),
      x: 1,
      y: 2,
      plane: 3,
      onBoat: false,
      world: 302,
    });
  });

  it('keeps isOnBoat', () => {
    expect(
      planSnapshot(null, loc({ x: 1, y: 2, plane: 0, isOnBoat: true }), ctx).locationSample?.onBoat,
    ).toBe(true);
  });

  it('falls back to the previous world, then null', () => {
    const prev: PrevState = {
      sourceDeviceId: null,
      sourceTs: null,
      skills: null,
      equipment: null,
      gameState: null,
      world: 330,
    };
    expect(planSnapshot(prev, loc({ x: 1, y: 2, plane: 0 }), ctx).locationSample?.world).toBe(330);
    expect(planSnapshot(null, loc({ x: 1, y: 2, plane: 0 }), ctx).locationSample?.world).toBeNull();
  });
});

describe('planSnapshot: sessions', () => {
  it.each([
    ['LOGGED_IN', true, true],
    ['LOADING', false, true],
    ['HOPPING', false, true],
    ['CONNECTION_LOST', false, true],
    ['LOGIN_SCREEN', false, false],
    ['LOGIN_SCREEN_AUTHENTICATOR', false, false],
    ['LOGGING_IN', false, false],
    ['STARTING', false, false],
    [null, false, false],
  ] as const)('%s → open %s, extend %s', (state, open, extend) => {
    const p = payload({ world: 302 }, state);
    expect(planSnapshot(null, p, ctxFor(p)).session).toEqual({ open, extend, world: 302 });
  });

  it('the logout fixture neither opens nor extends', () => {
    const p = fromFixture('logout');
    expect(planSnapshot(null, p, ctxFor(p)).session).toEqual({
      open: false,
      extend: false,
      world: 330,
    });
  });

  it('session world is null when the payload has none (not the previous world)', () => {
    const p = payload({ health: { current: 1, max: 10 } });
    expect(planSnapshot(prevAfterNormal(), p, ctxFor(p)).session.world).toBeNull();
  });
});
