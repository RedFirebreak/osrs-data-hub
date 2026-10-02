import { FIXTURES, FIXTURE_ACCOUNTS, fixtureBody, fixtureJson, httpCapture } from '@hub/fixtures';
import { describe, expect, it } from 'vitest';
import { KNOWN_SKILLS } from '../skills';
import { parsePayload, parsePayloadValue } from './parse';
import type { ParsedPayload } from './types';

type Json = Record<string, unknown>;
type Body = { player: Json & { stats: { skills: Json } }; events: Json[]; [k: string]: unknown };

const NUL = String.fromCharCode(0);
const HI = String.fromCharCode(0xd800);
const LO = String.fromCharCode(0xdc00);
const REPLACEMENT = String.fromCharCode(0xfffd);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** No string or key below holds NUL (text and jsonb reject it) or a lone surrogate (jsonb). */
function dbSafe(value: unknown): boolean {
  if (typeof value === 'string') return !value.includes(NUL) && !LONE_SURROGATE.test(value);
  if (Array.isArray(value)) return value.every(dbSafe);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).every(([k, v]) => dbSafe(k) && dbSafe(v));
  }
  return true;
}

/** Parses and asserts ok. */
function ok(input: string | unknown): ParsedPayload {
  const r = typeof input === 'string' ? parsePayload(input) : parsePayloadValue(input);
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.payload;
}

/** snapshot-normal with `edit` applied to a fresh copy. */
function normal(edit: (b: Body) => void = () => {}): ParsedPayload {
  const body = fixtureJson<Body>('snapshot-normal');
  edit(body);
  return ok(JSON.stringify(body));
}

const event = (overrides: Json = {}): Json => ({
  type: 'loot',
  data: { items: [] },
  eventId: 'c2738263-7f75-4bc7-8d23-6ba1dd38a62b',
  timestamp: 1790005400233,
  ...overrides,
});

describe('parsePayload: fixtures', () => {
  it.each(FIXTURES)('%s parses ok with nothing skipped', (name) => {
    const p = ok(fixtureBody(name));
    expect(p.skipped.sections).toEqual([]);
    expect(p.skipped.events).toBe(0);
    expect(p.skipped.reasons).toEqual(name === 'pair-request' ? ['events: missing'] : []);
    const raw = fixtureJson(name);
    expect(p.events).toHaveLength(Array.isArray(raw.events) ? raw.events.length : 0);
  });

  it('parses the full snapshot', () => {
    const p = ok(fixtureBody('snapshot-normal'));
    expect(p.state).toBe('LOGGED_IN');
    expect(p.tickDelay).toBe(100);
    expect(p.timestamp).toBe(fixtureJson('snapshot-normal').timestamp);
    expect(p.events).toEqual([]);
    const player = p.player!;
    expect(player.name).toBe('Zezima');
    expect(player.accountHash).toBe(FIXTURE_ACCOUNTS.zezima);
    expect(player.accountType).toBe(0);
    expect(player.world).toBe(302);
    expect(player.worldTypes).toEqual(['MEMBERS']);
    expect(player.location).toEqual({ x: 3164, y: 3487, plane: 0, isOnBoat: false });
    expect(player.health).toEqual({ current: 99, max: 99 });
    expect(player.prayer).toEqual({ current: 99, max: 99 });
    expect(player).not.toHaveProperty('prayerPoints');
    expect(player).not.toHaveProperty('stats');
    expect(player.spellbook).toEqual({ id: 2, name: 'lunar' });
    expect(Object.keys(player.skills!)).toEqual([...KNOWN_SKILLS]);
    expect(player.skills!.Attack).toEqual({ xp: 34512847, level: 108 });
    expect(player.skills).not.toHaveProperty('Overall');
    // One entry per slot: 4 Anglerfish are 4 entries.
    expect(player.inventory).toHaveLength(10);
    expect(player.inventory!.filter((i) => i.name === 'Anglerfish').length).toBeGreaterThan(1);
    expect(player.equipment).toHaveLength(9);
    expect(player.equipment!.every((i) => typeof i.equipmentSlot === 'string')).toBe(true);
    expect(player.equipment!.find((i) => i.equipmentSlot === 'WEAPON')).toMatchObject({ id: 4151 });
  });

  it('parses the partial player of a login stat sync as health only', () => {
    const p = ok(fixtureBody('login-partial-player'));
    expect(p.player).toEqual({ health: { current: 99, max: 99 } });
    expect(p.tickDelay).toBe(0);
    expect(p.state).toBe('LOGGED_IN');
    expect(p.events).toEqual([]);
  });

  it('parses a client-start logout without player', () => {
    const p = ok(fixtureBody('logout-client-start-no-player'));
    expect(p.player).toBeNull();
    expect(p.state).toBe('LOGIN_SCREEN');
    expect(p.tickDelay).toBe(0);
    expect(p.events).toHaveLength(1);
    expect(p.events[0]).toMatchObject({ type: 'clientShutdown', data: 'Logout' });
  });

  it('parses the disabled-on-login-screen payload without state', () => {
    const p = ok(fixtureBody('disabled-login-screen'));
    expect(p.player).toBeNull();
    expect(p.state).toBeNull();
    expect(p.events[0]).toMatchObject({ type: 'clientShutdown', data: 'Disabled' });
  });

  it('parses the pairing body as an empty payload', () => {
    const p = ok(fixtureBody('pair-request'));
    expect(p).toEqual({
      player: null,
      events: [],
      state: null,
      tickDelay: 0,
      timestamp: null,
      skipped: { sections: [], events: 0, reasons: ['events: missing'] },
    });
  });

  it('leaves filtered-out sections absent (not empty)', () => {
    const player = ok(fixtureBody('snapshot-no-sections')).player!;
    expect(player).not.toHaveProperty('inventory');
    expect(player).not.toHaveProperty('equipment');
    expect(player).not.toHaveProperty('location');
    expect(player.skills).toBeDefined();
  });

  it('keeps the stale special-world labels of a hop payload', () => {
    const player = ok(fixtureBody('hop-from-special-world-stale')).player!;
    expect(player.world).toBe(485);
    expect(player.worldTypes).toEqual(['MEMBERS', 'SEASONAL']);
  });

  it('parses an ironman accountType', () => {
    expect(ok(fixtureBody('event-death-dangerous')).player!.accountType).toBe(1);
  });

  it('keeps events as sent: data from the raw JSON, unknown types kept', () => {
    const loot = ok(fixtureBody('event-loot')).events[0]!;
    const raw = fixtureJson<{ events: Json[] }>('event-loot').events[0]!;
    expect(loot.type).toBe('loot');
    expect(loot.eventId).toBe(raw.eventId);
    expect(loot.timestamp).toBe(raw.timestamp);
    expect(loot.data).toEqual(raw.data);
    expect(loot.raw).toEqual(raw);
    // Gson's ' / = escapes are decoded by JSON.parse.
    expect(loot.data).toMatchObject({ source: { text: "Kree'arra" } });
    expect((loot.data as { items: Json[] }).items[1]).toMatchObject({
      rarity: 0.0026246719160104987,
    });

    const levelUp = ok(fixtureBody('event-levelup-multi')).events[0]!;
    expect(levelUp.data).toEqual([
      { skill: 'Hitpoints', level: 84 },
      { skill: 'Combat', level: 101 },
      { skill: 'Strength', level: 85 },
    ]);

    const unknown = ok(fixtureBody('event-unknown-type')).events[0]!;
    expect(unknown.type).toBe('questComplete');
    expect(unknown.data).toMatchObject({ questPoints: 5 });
  });

  it('keeps both identical diary events (different eventIds)', () => {
    const events = ok(fixtureBody('event-diary-repeat')).events;
    expect(events).toHaveLength(2);
    expect(events[0]!.data).toEqual(events[1]!.data);
    expect(events[0]!.eventId).not.toBe(events[1]!.eventId);
  });

  it('parses the body of the raw ingest capture', () => {
    const body = httpCapture('events-request').split(/\r?\n\r?\n/)[1]!;
    expect(ok(body)).toEqual({
      player: null,
      events: [],
      state: 'LOGGED_IN',
      tickDelay: 100,
      timestamp: 1790000000123,
      skipped: { sections: [], events: 0, reasons: [] },
    });
  });

  it('gives the same result for text and the parsed value', () => {
    for (const name of FIXTURES) {
      expect(parsePayloadValue(fixtureJson(name))).toEqual(parsePayload(fixtureBody(name)));
    }
  });
});

describe('parsePayload: body errors', () => {
  it.each(['', ' ', '{', '{"a":1', 'undefined', 'NaN', "{'a':1}", '{"a":1}x'])(
    '%j → not_json',
    (body) => {
      expect(parsePayload(body)).toEqual({ ok: false, error: 'not_json' });
    },
  );

  it.each(['[]', '[{"events":[]}]', 'null', '"text"', '42', 'true'])('%j → not_object', (body) => {
    expect(parsePayload(body)).toEqual({ ok: false, error: 'not_object' });
  });

  it('rejects non-plain objects given as values', () => {
    expect(parsePayloadValue(new Date())).toEqual({ ok: false, error: 'not_object' });
    expect(parsePayloadValue(new Map())).toEqual({ ok: false, error: 'not_object' });
    expect(parsePayloadValue(undefined)).toEqual({ ok: false, error: 'not_object' });
  });

  it('accepts an empty object', () => {
    expect(ok('{}')).toMatchObject({
      player: null,
      events: [],
      state: null,
      tickDelay: 0,
      timestamp: null,
    });
  });
});

describe('parsePayload: root fields', () => {
  it('reads null as missing, without a reason', () => {
    const p = ok('{"player":null,"events":[],"state":null,"tickDelay":null,"timestamp":null}');
    expect(p).toMatchObject({ player: null, state: null, tickDelay: 0, timestamp: null });
    expect(p.skipped).toEqual({ sections: [], events: 0, reasons: [] });
  });

  it.each([['"100"'], ['-1'], ['1.5'], ['1e400'], ['2147483648'], ['true'], ['{}']])(
    'tickDelay %s → 0 with a reason',
    (value) => {
      const p = ok(`{"events":[],"tickDelay":${value},"timestamp":1}`);
      expect(p.tickDelay).toBe(0);
      expect(p.skipped.sections).toEqual([]);
      expect(p.skipped.reasons).toHaveLength(1);
      expect(p.skipped.reasons[0]).toMatch(/^tickDelay: /);
    },
  );

  it('keeps a valid tickDelay of any size (the plugin has no maximum)', () => {
    expect(ok('{"events":[],"tickDelay":0}').tickDelay).toBe(0);
    expect(ok('{"events":[],"tickDelay":100000}').tickDelay).toBe(100000);
    expect(ok('{"events":[],"tickDelay":2147483647}').tickDelay).toBe(2147483647);
  });

  it.each([['"1790000000000"'], ['1e400'], ['[]']])(
    'timestamp %s → null with a reason',
    (value) => {
      const p = ok(`{"events":[],"timestamp":${value}}`);
      expect(p.timestamp).toBeNull();
      expect(p.skipped.reasons[0]).toMatch(/^timestamp: /);
    },
  );

  it('keeps any finite timestamp, including exponent notation', () => {
    expect(ok('{"events":[],"timestamp":1.79E12}').timestamp).toBe(1.79e12);
    expect(ok('{"events":[],"timestamp":-5}').timestamp).toBe(-5);
  });

  it('keeps any state string and drops a non-string one', () => {
    expect(ok('{"events":[],"state":"HOPPING"}').state).toBe('HOPPING');
    expect(ok('{"events":[],"state":"SOMETHING_NEW"}').state).toBe('SOMETHING_NEW');
    const p = ok('{"events":[],"state":7}');
    expect(p.state).toBeNull();
    expect(p.skipped.reasons[0]).toMatch(/^state: /);
  });

  it('ignores unknown root keys', () => {
    const p = ok('{"events":[],"config":{"x":1},"newRootField":true}');
    expect(p.skipped).toEqual({ sections: [], events: 0, reasons: [] });
  });
});

describe('parsePayload: player sections', () => {
  it('drops a non-object player and records it', () => {
    for (const player of ['"Zezima"', '[]', '42', 'true']) {
      const p = ok(`{"player":${player},"events":[]}`);
      expect(p.player).toBeNull();
      expect(p.skipped.sections).toEqual(['player']);
      expect(p.skipped.reasons[0]).toMatch(/^player: /);
    }
  });

  it('returns a player without identity (the caller decides)', () => {
    expect(ok('{"player":{},"events":[]}').player).toEqual({});
    expect(ok('{"player":{"world":"302"},"events":[]}').player).toEqual({ world: 302 });
  });

  it('parses accountType strings and numbers', () => {
    const at = (v: unknown) => normal((b) => (b.player.accountType = v)).player!.accountType;
    expect(at('3')).toBe(3);
    expect(at('0')).toBe(0);
    expect(at('6')).toBe(6);
    expect(at(3)).toBe(3);
    expect(at('127')).toBe(127);
  });

  it.each([['128'], ['-1'], ['3.0'], [' 3'], ['x'], [''], [3.5], [-1], [128], [true], [[3]]])(
    'drops accountType %j and records it',
    (value) => {
      const p = normal((b) => (b.player.accountType = value));
      expect(p.player).not.toHaveProperty('accountType');
      expect(p.skipped.sections).toEqual(['player.accountType']);
      expect(p.player!.name).toBe('Zezima');
    },
  );

  it('parses world strings and numbers', () => {
    const w = (v: unknown) => normal((b) => (b.player.world = v)).player!.world;
    expect(w('302')).toBe(302);
    expect(w(330)).toBe(330);
    expect(w('2147483647')).toBe(2147483647);
  });

  it.each([
    ['0'],
    [0],
    ['-302'],
    ['302a'],
    ['3.5'],
    [3.5],
    ['2147483648'],
    ['99999999999'],
    [null],
  ])('drops world %j', (value) => {
    const p = normal((b) => (b.player.world = value));
    expect(p.player).not.toHaveProperty('world');
    expect(p.skipped.sections).toEqual(value === null ? [] : ['player.world']);
  });

  it('maps health → health and prayerPoints → prayer', () => {
    const player = normal((b) => {
      b.player.health = { current: 84, max: 99 };
      b.player.prayerPoints = { current: 70, max: 99 };
    }).player!;
    expect(player.health).toEqual({ current: 84, max: 99 });
    expect(player.prayer).toEqual({ current: 70, max: 99 });
  });

  it('allows a boosted current above max', () => {
    expect(normal((b) => (b.player.health = { current: 116, max: 99 })).player!.health).toEqual({
      current: 116,
      max: 99,
    });
  });

  it('drops a wrong-shaped meter by its wire path', () => {
    const p = normal((b) => {
      b.player.health = { current: '84', max: 99 };
      b.player.prayerPoints = { current: 40000, max: 99 };
    });
    expect(p.player).not.toHaveProperty('health');
    expect(p.player).not.toHaveProperty('prayer');
    expect(p.skipped.sections).toEqual(['player.health', 'player.prayerPoints']);
  });

  it('drops a wrong-shaped location, stats and inventory while the rest survives', () => {
    const p = normal((b) => {
      b.player.location = { x: 3164, y: 'north', plane: 0 };
      b.player.stats = 'lots' as never;
      b.player.inventory = {
        items: [
          { id: 385, quantity: 1, gePrice: 963 },
          { id: 'shark', quantity: 1, gePrice: 1 },
        ],
      };
    });
    expect(p.skipped.sections).toEqual(['player.location', 'player.stats', 'player.inventory']);
    expect(p.skipped.reasons).toHaveLength(3);
    expect(p.skipped.reasons[0]).toMatch(/^player\.location: y: /);
    expect(p.skipped.reasons[2]).toMatch(/^player\.inventory: items\.1\.id: /);
    const player = p.player!;
    expect(player).not.toHaveProperty('location');
    expect(player).not.toHaveProperty('skills');
    expect(player).not.toHaveProperty('inventory');
    expect(player.name).toBe('Zezima');
    expect(player.accountHash).toBe(FIXTURE_ACCOUNTS.zezima);
    expect(player.world).toBe(302);
    expect(player.health).toEqual({ current: 99, max: 99 });
    expect(player.equipment).toHaveLength(9);
    expect(player.spellbook).toEqual({ id: 2, name: 'lunar' });
  });

  it('validates location coordinates as integers in range', () => {
    const loc = (v: unknown) => normal((b) => (b.player.location = v));
    expect(loc({ x: 1, y: 2, plane: 3 }).player!.location).toEqual({ x: 1, y: 2, plane: 3 });
    expect(loc({ x: 1, y: 2, plane: 1, isOnBoat: true }).player!.location).toMatchObject({
      isOnBoat: true,
    });
    for (const bad of [
      { x: 1.5, y: 2, plane: 0 },
      { x: 1, y: 2 },
      { x: 1, y: 2, plane: 40000 },
      { x: 2 ** 31, y: 2, plane: 0 },
      { x: 1, y: 2, plane: 0, isOnBoat: 'no' },
      [1, 2, 0],
    ]) {
      expect(loc(bad).skipped.sections).toEqual(['player.location']);
    }
  });

  it('keeps the location trail of plugin 1.6 as sent, oldest first', () => {
    const trail = (v: unknown) => normal((b) => (b.player.locationTrail = v));
    // Two points of a live 1.6 payload.
    const points = [
      { x: 2963, y: 3253, plane: 0, isOnBoat: false, timestamp: 1790950466236 },
      { x: 2965, y: 3255, plane: 0, isOnBoat: false, timestamp: 1790950466832 },
    ];
    const p = trail(points);
    expect(p.skipped).toEqual({ sections: [], events: 0, reasons: [] });
    expect(p.player!.locationTrail).toEqual(points);
    // A player who stood still sends an empty trail: kept, it tells 1.6 from an older plugin.
    expect(trail([]).player!.locationTrail).toEqual([]);
    expect(normal().player).not.toHaveProperty('locationTrail');
    // isOnBoat is optional, as on location; unknown keys stay (the unreleased `teleport` flag).
    expect(
      trail([{ x: 1, y: 2, plane: 0, timestamp: 5, teleport: true }]).player!.locationTrail,
    ).toEqual([{ x: 1, y: 2, plane: 0, timestamp: 5, teleport: true }]);
  });

  it('drops the whole location trail when one point is invalid, and keeps location', () => {
    const point = { x: 1, y: 2, plane: 0, isOnBoat: false, timestamp: 1790950466236 };
    for (const bad of [
      [point, { ...point, x: 1.5 }],
      [{ ...point, plane: 40000 }],
      [{ x: 1, y: 2, plane: 0 }],
      [{ ...point, timestamp: 1790950466236.5 }],
      [{ ...point, timestamp: '1790950466236' }],
      [{ ...point, isOnBoat: 'no' }],
      [point, null],
      point,
    ]) {
      const p = normal((b) => (b.player.locationTrail = bad));
      expect(p.skipped.sections).toEqual(['player.locationTrail']);
      expect(p.player).not.toHaveProperty('locationTrail');
      expect(p.player!.location).toEqual({ x: 3164, y: 3487, plane: 0, isOnBoat: false });
    }
  });

  it('accepts at most 512 trail points (the plugin sends at most 300)', () => {
    const points = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ x: i, y: 0, plane: 0, timestamp: 1000 + i }));
    expect(
      normal((b) => (b.player.locationTrail = points(512))).player!.locationTrail,
    ).toHaveLength(512);
    const p = normal((b) => (b.player.locationTrail = points(513)));
    expect(p.skipped.sections).toEqual(['player.locationTrail']);
    expect(p.skipped.reasons).toEqual(['player.locationTrail: more than 512 points']);
  });

  it('reads a null inside a section as a missing key', () => {
    const p = normal((b) => {
      b.player.location = { x: 1, y: 2, plane: 0, isOnBoat: null, region: null };
      (b.player.inventory as { items: Json[] }).items[0]!.haPrice = null;
      (b.player.inventory as { items: Json[] }).items[1]!.name = null;
      (b.player.equipment as { items: Json[] }).items[0]!.equipmentSlot = null;
      b.player.stats.skills.Attack = { xp: 1, level: 1, rank: null };
    });
    expect(p.skipped).toEqual({ sections: [], events: 0, reasons: [] });
    const player = p.player!;
    expect(player.location).toEqual({ x: 1, y: 2, plane: 0 });
    expect(player.inventory![0]).not.toHaveProperty('haPrice');
    expect(player.inventory![1]).not.toHaveProperty('name');
    expect(player.equipment![0]).not.toHaveProperty('equipmentSlot');
    expect(player.skills!.Attack).toEqual({ xp: 1, level: 1 });
  });

  it('drops a section whose required value is null (a missing key or array element)', () => {
    const p = normal((b) => {
      b.player.health = { current: null, max: 99 };
      b.player.worldTypes = [null, 'MEMBERS'];
      b.player.inventory = { items: null };
      b.player.equipment = { items: [null] };
    });
    expect(p.skipped.sections).toEqual([
      'player.worldTypes',
      'player.health',
      'player.inventory',
      'player.equipment',
    ]);
  });

  it('keeps unknown keys inside sections (looseObject)', () => {
    const player = normal((b) => {
      b.player.location = { x: 1, y: 2, plane: 0, isOnBoat: false, region: 12850 };
      (b.player.equipment as { items: Json[] }).items[0]!.charges = 5;
      b.player.spellbook = { id: 1, name: 'ancient', extra: [1] };
    }).player!;
    expect(player.location).toEqual({ x: 1, y: 2, plane: 0, isOnBoat: false, region: 12850 });
    expect(player.equipment![0]).toMatchObject({ charges: 5 });
    expect(player.spellbook).toEqual({ id: 1, name: 'ancient', extra: [1] });
  });

  it('never lets a "__proto__" key leak into the result', () => {
    const body =
      '{"player":{"__proto__":{"name":"Evil"},"location":{"x":1,"y":2,"plane":0,"__proto__":{"isOnBoat":true}}},"events":[]}';
    const player = ok(body).player!;
    expect(player.name).toBeUndefined();
    expect(Object.getPrototypeOf(player)).toBe(Object.prototype);
    expect(player.location!.isOnBoat).toBeUndefined();
    expect(Object.getPrototypeOf(player.location)).toBe(Object.prototype);
  });

  it('validates name, accountHash and worldTypes', () => {
    const p = normal((b) => {
      b.player.name = '';
      b.player.accountHash = 12345;
      b.player.worldTypes = ['MEMBERS', 3];
    });
    expect(p.skipped.sections).toEqual(['player.name', 'player.accountHash', 'player.worldTypes']);
    expect(p.player).not.toHaveProperty('name');
    expect(p.player).not.toHaveProperty('accountHash');
    expect(p.player).not.toHaveProperty('worldTypes');
    expect(normal((b) => (b.player.name = 'x'.repeat(65))).skipped.sections).toEqual([
      'player.name',
    ]);
    expect(normal((b) => (b.player.accountHash = 'a'.repeat(129))).skipped.sections).toEqual([
      'player.accountHash',
    ]);
    expect(normal((b) => (b.player.worldTypes = [])).player!.worldTypes).toEqual([]);
  });

  it('drops a worldTypes that is not an array of strings', () => {
    for (const worldTypes of ['MEMBERS', { 0: 'MEMBERS' }, [['MEMBERS']]]) {
      expect(normal((b) => (b.player.worldTypes = worldTypes)).skipped.sections).toEqual([
        'player.worldTypes',
      ]);
    }
  });

  it('validates the spellbook', () => {
    expect(
      normal((b) => (b.player.spellbook = { id: 40000, name: 'lunar' })).skipped.sections,
    ).toEqual(['player.spellbook']);
    expect(normal((b) => (b.player.spellbook = { id: 2 })).skipped.sections).toEqual([
      'player.spellbook',
    ]);
    expect(
      normal((b) => (b.player.spellbook = { id: 'lunar', name: 'lunar' })).skipped.sections,
    ).toEqual(['player.spellbook']);
  });
});

describe('parsePayload: stats.skills', () => {
  it('drops only an invalid skill entry and records its path', () => {
    const p = normal((b) => {
      b.player.stats.skills.Attack = { xp: -1, level: 1 };
      b.player.stats.skills.Magic = { xp: 100, level: 1.5 };
      b.player.stats.skills.Cooking = 'max';
    });
    expect(p.skipped.sections).toEqual([
      'player.stats.skills.Attack',
      'player.stats.skills.Magic',
      'player.stats.skills.Cooking',
    ]);
    const skills = p.player!.skills!;
    expect(Object.keys(skills)).toHaveLength(21);
    expect(skills).not.toHaveProperty('Attack');
    expect(skills).not.toHaveProperty('Magic');
    expect(skills.Strength).toEqual({ xp: 52611904, level: 113 });
  });

  it('drops an Overall entry (the hub derives it)', () => {
    const p = normal((b) => (b.player.stats.skills.Overall = { xp: 1, level: 2277 }));
    expect(p.player!.skills).not.toHaveProperty('Overall');
    expect(p.skipped.sections).toEqual(['player.stats.skills.Overall']);
  });

  it('drops a Combat entry (the plugin sends Combat only in levelUp events)', () => {
    const p = normal((b) => (b.player.stats.skills.Combat = { xp: 0, level: 126 }));
    expect(p.player!.skills).not.toHaveProperty('Combat');
    expect(Object.keys(p.player!.skills!)).toEqual([...KNOWN_SKILLS]);
    expect(p.skipped.sections).toEqual(['player.stats.skills.Combat']);
  });

  it('drops skill names that are empty, longer than 64 characters or "__proto__"', () => {
    const long = 'L'.repeat(65);
    const body = fixtureBody('snapshot-normal').replace(
      '"skills":{',
      `"skills":{"":{"xp":1,"level":1},"${long}":{"xp":1,"level":1},"__proto__":{"xp":1,"level":1},"${'M'.repeat(64)}":{"xp":1,"level":1},`,
    );
    const p = ok(body);
    expect(p.skipped.sections).toEqual([
      'player.stats.skills.',
      `player.stats.skills.${'L'.repeat(64)}`,
      'player.stats.skills.__proto__',
    ]);
    const skills = p.player!.skills!;
    expect(Object.keys(skills)).toEqual(['M'.repeat(64), ...KNOWN_SKILLS]);
    expect(Object.getPrototypeOf(skills)).toBe(Object.prototype);
  });

  it('drops the whole stats section with more than 64 entries (the plugin sends 24)', () => {
    const many = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`S${i}`, { xp: i, level: 1 }]));
    const at64 = normal((b) => (b.player.stats.skills = many(64)));
    expect(Object.keys(at64.player!.skills!)).toHaveLength(64);
    expect(at64.skipped.sections).toEqual([]);
    const at65 = normal((b) => (b.player.stats.skills = many(65)));
    expect(at65.player).not.toHaveProperty('skills');
    expect(at65.skipped.sections).toEqual(['player.stats']);
    expect(at65.skipped.reasons).toEqual(['player.stats: more than 64 skills']);
  });

  it('accepts new skills and virtual levels up to 127', () => {
    const skills = normal((b) => {
      b.player.stats.skills.Necromancy = { xp: 0, level: 1 };
      b.player.stats.skills.Attack = { xp: 200_000_000, level: 127 };
    }).player!.skills!;
    expect(skills.Necromancy).toEqual({ xp: 0, level: 1 });
    expect(skills.Attack).toEqual({ xp: 200_000_000, level: 127 });
  });

  it('rejects xp beyond a Java int and levels beyond smallint', () => {
    const p = normal((b) => {
      b.player.stats.skills.Attack = { xp: 2 ** 31, level: 127 };
      b.player.stats.skills.Defence = { xp: 1, level: 40000 };
    });
    expect(p.skipped.sections).toEqual([
      'player.stats.skills.Attack',
      'player.stats.skills.Defence',
    ]);
  });

  it('omits skills when no entry is valid', () => {
    const all = normal((b) => {
      for (const k of Object.keys(b.player.stats.skills))
        b.player.stats.skills[k] = { xp: 'x', level: 1 };
    });
    expect(all.player).not.toHaveProperty('skills');
    expect(all.skipped.sections).toHaveLength(24);
    const empty = normal((b) => (b.player.stats.skills = {}));
    expect(empty.player).not.toHaveProperty('skills');
    expect(empty.skipped.sections).toEqual([]);
  });

  it('skips a null skill entry as missing', () => {
    const p = normal((b) => (b.player.stats.skills.Attack = null));
    expect(p.player!.skills).not.toHaveProperty('Attack');
    expect(p.skipped.sections).toEqual([]);
  });

  it('drops a stats section without a skills object', () => {
    for (const stats of [{}, { skills: [] }, { skills: 'x' }, [], 5]) {
      const p = normal((b) => (b.player.stats = stats as never));
      expect(p.player).not.toHaveProperty('skills');
      expect(p.skipped.sections).toEqual(['player.stats']);
    }
  });
});

describe('parsePayload: inventory and equipment', () => {
  it('keeps an empty inventory (a real, empty inventory)', () => {
    const p = normal((b) => (b.player.inventory = { items: [] }));
    expect(p.player!.inventory).toEqual([]);
    expect(p.skipped.sections).toEqual([]);
  });

  it('drops the whole section for one invalid item', () => {
    const p = normal((b) => {
      (b.player.equipment as { items: Json[] }).items[3]!.gePrice = 1.5;
    });
    expect(p.player).not.toHaveProperty('equipment');
    expect(p.skipped.sections).toEqual(['player.equipment']);
    expect(p.player!.inventory).toHaveLength(10);
  });

  it.each([
    [{}],
    [{ items: {} }],
    [[]],
    [{ items: [{ id: 1, quantity: 1 }] }],
    [{ items: [{ id: 1, quantity: 1, gePrice: 1, name: 5 }] }],
    [{ items: [{ id: 1, quantity: 1, gePrice: 1, haPrice: '1' }] }],
    [{ items: [{ id: 1, quantity: 1, gePrice: 1, equipmentSlot: 3 }] }],
    [{ items: [{ id: 1, quantity: 1, gePrice: 1, rarity: '0.1' }] }],
    [{ items: [null] }],
    [{ items: [{ id: 2 ** 31, quantity: 1, gePrice: 1 }] }],
    [{ items: [{ id: 1, quantity: 2 ** 31, gePrice: 1 }] }],
    [{ items: [{ id: 1, quantity: -(2 ** 31) - 1, gePrice: 1 }] }],
    [{ items: [{ id: 1, quantity: 1, gePrice: 2 ** 53 }] }],
    [{ items: [{ id: 1, quantity: 1, gePrice: 1, haPrice: 1.5 }] }],
    [{ items: [{ id: 1, quantity: 1, gePrice: 1, rarity: true }] }],
    [{ items: [{ id: 1, quantity: 1, gePrice: 1, inventorySlot: -1 }] }],
    [{ items: [{ id: 1, quantity: 1, gePrice: 1, inventorySlot: 1.5 }] }],
    [{ items: [{ id: 1, quantity: 1, gePrice: 1, inventorySlot: '3' }] }],
  ])('drops inventory %j', (inventory) => {
    const p = normal((b) => (b.player.inventory = inventory));
    expect(p.player).not.toHaveProperty('inventory');
    expect(p.skipped.sections).toEqual(['player.inventory']);
  });

  it('accepts minimal items and optional fields', () => {
    const items = normal((b) => {
      b.player.inventory = {
        items: [
          { id: 995, quantity: 2147483647, gePrice: 1 },
          {
            id: 4151,
            quantity: 1,
            gePrice: 9007199254740991,
            haPrice: 72000,
            name: 'Abyssal whip',
          },
        ],
      };
    }).player!.inventory!;
    expect(items).toEqual([
      { id: 995, quantity: 2147483647, gePrice: 1 },
      { id: 4151, quantity: 1, gePrice: 9007199254740991, haPrice: 72000, name: 'Abyssal whip' },
    ]);
  });

  it('keeps inventorySlot as plugin 1.5.1 sends it (empty slots omitted, PLUGIN-11)', () => {
    const body = fixtureBody('snapshot-normal').replace(
      '"inventory":{"items":[',
      '"inventory":{"items":[{"name":"Abyssal whip","id":4151,"gePrice":1650000,"haPrice":72000,"quantity":1,"inventorySlot":0},{"name":"Shark","id":385,"gePrice":900,"haPrice":60,"quantity":1,"inventorySlot":27},',
    );
    const p = ok(body);
    expect(p.skipped.sections).toEqual([]);
    expect(p.player!.inventory!.slice(0, 2).map((i) => i.inventorySlot)).toEqual([0, 27]);
    expect(p.player!.inventory![2]).not.toHaveProperty('inventorySlot');
  });

  it('drops a section holding a number JSON.parse turns into Infinity', () => {
    const body = fixtureBody('snapshot-normal').replace(
      '"quantity":1',
      '"quantity":1,"rarity":1e400',
    );
    expect(ok(body).skipped.sections).toEqual(['player.inventory']);
  });

  it('parses exponent-notation rarity (Double.toString below 1e-3)', () => {
    const body = fixtureBody('snapshot-normal').replace(
      '"inventory":{"items":[',
      '"inventory":{"items":[{"rarity":2.0E-4,"name":"Rare","id":1,"gePrice":5,"haPrice":1,"quantity":1},',
    );
    const p = ok(body);
    expect(p.skipped.sections).toEqual([]);
    expect(p.player!.inventory![0]).toEqual({
      rarity: 0.0002,
      name: 'Rare',
      id: 1,
      gePrice: 5,
      haPrice: 1,
      quantity: 1,
    });
  });
});

describe('parsePayload: events', () => {
  const withEvents = (events: unknown) => ok({ events });

  it('skips and counts malformed events, keeping the others', () => {
    const good1 = event({ eventId: 'a' });
    const good2 = event({ eventId: 'b', type: 'death' });
    const p = withEvents([
      good1,
      event({ eventId: undefined }),
      event({ type: 5 }),
      event({ type: '' }),
      event({ type: 't'.repeat(65) }),
      event({ eventId: '' }),
      event({ eventId: 'e'.repeat(129) }),
      event({ eventId: 42 }),
      null,
      'loot',
      [event()],
      good2,
    ]);
    expect(p.skipped.events).toBe(10);
    expect(p.events.map((e) => e.eventId)).toEqual(['a', 'b']);
    expect(p.skipped.sections).toEqual([]);
    expect(p.skipped.reasons).toHaveLength(10);
    expect(p.skipped.reasons[0]).toMatch(/^events\[1\]: eventId: /);
    expect(p.skipped.reasons[1]).toMatch(/^events\[2\]: type: /);
    expect(p.skipped.reasons.slice(7)).toEqual([
      'events[8]: expected an object',
      'events[9]: expected an object',
      'events[10]: expected an object',
    ]);
  });

  it('requires a data key but accepts any value, null included', () => {
    const noData = event();
    delete noData.data;
    const p = withEvents([
      noData,
      event({ data: null }),
      event({ data: 'Logout' }),
      event({ data: [1] }),
      event({ data: 0 }),
    ]);
    expect(p.skipped.events).toBe(1);
    expect(p.skipped.reasons).toEqual(['events[0]: data: missing']);
    expect(p.events.map((e) => e.data)).toEqual([null, 'Logout', [1], 0]);
  });

  it('keeps an event with a missing or invalid timestamp, as null', () => {
    const noTs = event();
    delete noTs.timestamp;
    const p = withEvents([
      noTs,
      event({ timestamp: null }),
      event({ timestamp: '1790000000000' }),
      event({ timestamp: 5 }),
    ]);
    expect(p.skipped.events).toBe(0);
    expect(p.events.map((e) => e.timestamp)).toEqual([null, null, null, 5]);
    expect(p.skipped.reasons).toEqual(['events[2].timestamp: expected a finite number']);
    const huge = ok('{"events":[{"type":"loot","data":{},"eventId":"x","timestamp":1e400}]}');
    expect(huge.events[0]!.timestamp).toBeNull();
    expect(huge.skipped.reasons).toEqual(['events[0].timestamp: expected a finite number']);
  });

  it('passes the original element through as raw, with unknown keys', () => {
    const el = event({ extra: { nested: true } });
    const p = withEvents([el]);
    expect(p.events[0]!.raw).toBe(el);
    expect(p.events[0]!.data).toBe(el.data);
    expect(p.events[0]).toEqual({
      type: 'loot',
      data: { items: [] },
      eventId: 'c2738263-7f75-4bc7-8d23-6ba1dd38a62b',
      timestamp: 1790005400233,
      raw: el,
    });
  });

  it('keeps exponent-notation numbers inside event data', () => {
    const body =
      '{"events":[{"type":"loot","data":{"items":[{"rarity":9.84251968503937E-4}]},"eventId":"x","timestamp":1}]}';
    const data = ok(body).events[0]!.data as { items: { rarity: number }[] };
    expect(data.items[0]!.rarity).toBeCloseTo(1 / 1016, 15);
  });

  it('records a missing events array as a reason only', () => {
    const p = ok('{"tickDelay":100,"timestamp":1}');
    expect(p.events).toEqual([]);
    expect(p.skipped).toEqual({ sections: [], events: 0, reasons: ['events: missing'] });
    expect(ok('{"events":null}').skipped.reasons).toEqual(['events: missing']);
  });

  it('records a non-array events as a dropped section', () => {
    for (const events of ['{}', '"loot"', '5']) {
      const p = ok(`{"events":${events}}`);
      expect(p.events).toEqual([]);
      expect(p.skipped.sections).toEqual(['events']);
      expect(p.skipped.events).toBe(0);
    }
  });

  it('keeps an empty events array silently', () => {
    expect(ok('{"events":[]}').skipped).toEqual({ sections: [], events: 0, reasons: [] });
  });
});

describe('parsePayload: strings (Postgres text and jsonb safety)', () => {
  it('removes NUL from every player string and key, and from state', () => {
    const p = ok({
      player: {
        name: `Ze${NUL}zima`,
        accountHash: `${FIXTURE_ACCOUNTS.zezima}${NUL}`,
        worldTypes: [`MEMBERS${NUL}`],
        location: { x: 1, y: 2, plane: 0, [`re${NUL}gion`]: `a${NUL}` },
        spellbook: { id: 0, name: `stan${NUL}dard` },
        stats: { skills: { [`Att${NUL}ack`]: { xp: 1, level: 1 } } },
        inventory: { items: [{ id: 385, quantity: 1, gePrice: 1, name: `Sha${NUL}rk` }] },
        equipment: { items: [{ id: 1, quantity: 1, gePrice: 1, equipmentSlot: `HEAD${NUL}` }] },
      },
      events: [],
      state: `LOGGED_IN${NUL}`,
    });
    expect(p.skipped).toEqual({ sections: [], events: 0, reasons: [] });
    expect(p.state).toBe('LOGGED_IN');
    expect(p.player).toEqual({
      name: 'Zezima',
      accountHash: FIXTURE_ACCOUNTS.zezima,
      worldTypes: ['MEMBERS'],
      location: { x: 1, y: 2, plane: 0, region: 'a' },
      spellbook: { id: 0, name: 'standard' },
      skills: { Attack: { xp: 1, level: 1 } },
      inventory: [{ id: 385, quantity: 1, gePrice: 1, name: 'Shark' }],
      equipment: [{ id: 1, quantity: 1, gePrice: 1, equipmentSlot: 'HEAD' }],
    });
  });

  it('replaces lone surrogates in player strings and keys with U+FFFD', () => {
    const player = normal((b) => {
      b.player.name = `Ze${HI}zima`;
      b.player.location = { x: 1, y: 2, plane: 0, [`k${LO}`]: [`v${HI}`] };
      (b.player.inventory as { items: Json[] }).items[0]!.name = `${LO}Anglerfish`;
    }).player!;
    expect(player.name).toBe(`Ze${REPLACEMENT}zima`);
    expect(player.location).toEqual({
      x: 1,
      y: 2,
      plane: 0,
      [`k${REPLACEMENT}`]: [`v${REPLACEMENT}`],
    });
    expect(player.inventory![0]!.name).toBe(`${REPLACEMENT}Anglerfish`);
  });

  it('checks string lengths after removing NUL', () => {
    const p = normal((b) => {
      b.player.name = NUL.repeat(3);
      b.player.accountHash = `${'a'.repeat(128)}${NUL}`;
    });
    expect(p.skipped.sections).toEqual(['player.name']);
    expect(p.player).not.toHaveProperty('name');
    expect(p.player!.accountHash).toBe('a'.repeat(128));
  });

  it('keeps skipped paths storable (a hostile skill name lands in raw_payloads.meta)', () => {
    const p = ok({ player: { stats: { skills: { [`${HI}x${NUL}`]: 'max' } } }, events: [] });
    expect(p.skipped.sections).toEqual([`player.stats.skills.${REPLACEMENT}x`]);
    expect(dbSafe(p.skipped)).toBe(true);
  });

  it('returns everything but the events storable for a body full of NUL and lone surrogates', () => {
    const junk = `${NUL}${LO}${HI}${NUL}`;
    const body = fixtureJson<Body>('snapshot-normal');
    body.state = junk;
    body.player.name = `Z${junk}`;
    body.player.worldTypes = [junk, 'MEMBERS'];
    body.player.stats.skills[junk] = { xp: 1, level: 1 };
    body.player.stats.skills[`${junk}bad`] = { xp: -1, level: 1 };
    body.player.location = { x: 1, y: 2, plane: 0, [junk]: { [junk]: junk } };
    for (const section of ['inventory', 'equipment'] as const) {
      for (const item of (body.player[section] as { items: Json[] }).items) item.name = junk;
    }
    const p = ok(JSON.stringify(body));
    expect(p.player!.skills).toHaveProperty(REPLACEMENT.repeat(2));
    expect(dbSafe({ player: p.player, state: p.state, skipped: p.skipped })).toBe(true);
  });

  it('leaves events as sent: raw, data, type and eventId keep NUL (normalizeEvents sanitizes them)', () => {
    const el = event({ type: `lo${NUL}ot`, eventId: `id${NUL}`, data: { text: NUL } });
    const p = ok({ events: [el] });
    expect(p.events[0]).toEqual({
      type: `lo${NUL}ot`,
      data: { text: NUL },
      eventId: `id${NUL}`,
      timestamp: el.timestamp,
      raw: el,
    });
    expect(p.events[0]!.raw).toBe(el);
  });

  it('keeps non-ASCII names as sent', () => {
    expect(normal((b) => (b.player.name = 'Ir\u00f8n Mira')).player!.name).toBe('Ir\u00f8n Mira');
    expect(normal((b) => (b.player.name = 'Ze\u{1F600}')).player!.name).toBe('Ze\u{1F600}');
  });

  it('does not modify the value it is given', () => {
    const body = fixtureJson<Body>('snapshot-normal');
    body.player.name = `Ze${NUL}zima`;
    body.events = [event({ data: { text: `a${NUL}${HI}` } })];
    const copy = structuredClone(body);
    ok(body);
    expect(body).toEqual(copy);
  });
});

describe('parsePayload: nesting depth', () => {
  const nest = (levels: number): unknown => {
    let v: unknown = 0;
    for (let i = 0; i < levels; i++) v = [v];
    return v;
  };

  it('keeps an event nested up to 32 levels and skips a deeper one', () => {
    // The element is level 1, so data may nest 31 levels.
    const p = ok({ events: [event({ data: nest(31) }), event({ data: nest(32) })] });
    expect(p.events).toHaveLength(1);
    expect(p.skipped.events).toBe(1);
    expect(p.skipped.reasons).toEqual(['events[1]: nested deeper than 32 levels']);
  });

  it('drops a player section with deeply nested unknown content', () => {
    const p = normal((b) => (b.player.location = { x: 1, y: 2, plane: 0, junk: nest(40) }));
    expect(p.player).not.toHaveProperty('location');
    expect(p.skipped.sections).toEqual(['player.location']);
    expect(p.player!.name).toBe('Zezima');
  });

  it('survives a body nested ~100k levels deep (within the 256 KB limit)', () => {
    const n = 100_000;
    const body = `{"events":[{"type":"x","eventId":"y","data":${'['.repeat(n)}${']'.repeat(n)}},${JSON.stringify(event())}]}`;
    const p = ok(body);
    expect(p.events).toHaveLength(1);
    expect(p.skipped.events).toBe(1);
    // What survives is safe to serialize.
    expect(() => JSON.stringify(p)).not.toThrow();
  });
});

describe('parsePayload: skipped caps', () => {
  it('lists at most 64 reasons, then a count of the rest', () => {
    const p = ok({ events: Array.from({ length: 200 }, () => 1) });
    expect(p.skipped.events).toBe(200);
    expect(p.skipped.reasons).toHaveLength(65);
    expect(p.skipped.reasons[63]).toBe('events[63]: expected an object');
    expect(p.skipped.reasons[64]).toBe('… 136 more');
  });

  it('lists at most 64 sections', () => {
    const skills = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`S${i}`, 'x']));
    const player = { name: 5, accountHash: 5, world: 'x', worldTypes: 5, stats: { skills } };
    const p = ok({ player, events: [] });
    expect(p.skipped.sections).toHaveLength(64);
    expect(p.skipped.sections.slice(0, 4)).toEqual([
      'player.name',
      'player.accountHash',
      'player.world',
      'player.worldTypes',
    ]);
    expect(p.skipped.reasons).toHaveLength(65);
    expect(p.skipped.reasons[64]).toBe('… 4 more');
  });
});

describe('parsePayload: mutated fixtures (seeded fuzz)', () => {
  const WEIRD: unknown[] = [null, 0, -1, 1.5, 2 ** 31, 2 ** 53, 1e300, '', NUL, HI, '302', [], {}];
  const KEYS = ['__proto__', 'constructor', '', 'Overall', 'Combat', `x${NUL}`];

  it('never throws, and returns numbers in range and storable strings', () => {
    let seed = 20260928;
    // 32-bit LCG (Numerical Recipes constants): exact integer math, period 2^32.
    const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;
    const mutate = (v: unknown): unknown => {
      if (rnd() < 0.08) return pick(WEIRD);
      if (Array.isArray(v)) return v.map(mutate);
      if (typeof v !== 'object' || v === null) return v;
      const out: Json = {};
      for (const [k, x] of Object.entries(v)) {
        if (rnd() < 0.05) continue;
        const key = rnd() < 0.03 ? pick(KEYS) : k;
        Object.defineProperty(out, key, { value: mutate(x), enumerable: true, writable: true });
      }
      return out;
    };
    for (let i = 0; i < 1500; i++) {
      const r = parsePayload(JSON.stringify(mutate(fixtureJson(pick(FIXTURES)))));
      if (!r.ok) {
        expect(r.error).toBe('not_object'); // the root itself was replaced
        continue;
      }
      const p = r.payload;
      expect(dbSafe({ player: p.player, state: p.state, skipped: p.skipped })).toBe(true);
      expect(Number.isInteger(p.tickDelay) && p.tickDelay >= 0).toBe(true);
      for (const [name, skill] of Object.entries(p.player?.skills ?? {})) {
        expect(['Overall', 'Combat', '__proto__']).not.toContain(name);
        expect(Number.isInteger(skill.xp) && skill.xp >= 0 && skill.xp < 2 ** 31).toBe(true);
      }
      for (const item of [...(p.player?.inventory ?? []), ...(p.player?.equipment ?? [])]) {
        expect(Number.isSafeInteger(item.gePrice) && Number.isInteger(item.id)).toBe(true);
      }
    }
  });
});
