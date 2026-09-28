import { fixtureJson, type FixtureName } from '@hub/fixtures';
import { describe, expect, it } from 'vitest';
import type { RawEvent } from '../payload/types';
import { EVENT_CLAMP_MS } from '../time';
import { normalizeEvents } from './normalize';
import type { NormalizedEvent } from './types';

/** The fixture's events as parsePayload would hand them over (built by hand). */
function rawEvents(name: FixtureName): RawEvent[] {
  const body = fixtureJson<{ events: Record<string, unknown>[] }>(name);
  return body.events.map((raw) => event(raw));
}

function event(raw: Record<string, unknown>): RawEvent {
  return {
    type: raw.type as string,
    data: raw.data,
    eventId: raw.eventId as string,
    timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : null,
    raw,
  };
}

/** A receive time 2 s after the fixture's root timestamp. */
function recvFor(name: FixtureName): Date {
  return new Date(fixtureJson<{ timestamp: number }>(name).timestamp + 2000);
}

function only(name: FixtureName): NormalizedEvent {
  const result = normalizeEvents(rawEvents(name), recvFor(name));
  expect(result.skipped).toBe(0);
  expect(result.shutdown).toBeNull();
  expect(result.events).toHaveLength(1);
  return result.events[0]!;
}

const recv = new Date('2026-09-21T13:40:00.000Z');
const R = recv.getTime();

function ev(type: string, data: unknown, extra: Partial<RawEvent> = {}): RawEvent {
  const eventId = extra.eventId ?? `id-${type}`;
  const timestamp = extra.timestamp === undefined ? R - 1000 : extra.timestamp;
  return { type, data, eventId, timestamp, raw: { type, data, eventId, timestamp }, ...extra };
}

describe('normalizeEvents: fixtures', () => {
  it('loot: value recomputed from ALL items, highest item id, npc id, original data kept', () => {
    const raw = rawEvents('event-loot')[0]!;
    const row = only('event-loot');
    expect(row).toEqual({
      pluginEventId: 'c2738263-7f75-4bc7-8d23-6ba1dd38a62b',
      subIndex: 0,
      type: 'loot',
      occurredAt: new Date(1790005400233),
      valueGp: 310 + 35_236_970,
      itemId: 11828,
      npcId: 3162,
      skill: null,
      level: null,
      tier: null,
      points: null,
      data: raw.raw,
    });
    // Gson's HTML escapes are decoded by JSON.parse; the stored data is the plain text.
    expect((row.data as { data: { source: { text: string } } }).data.source.text).toBe("Kree'arra");
  });

  it('pkLoot: pk_loot, no npcId', () => {
    const row = only('event-pkloot');
    expect(row).toMatchObject({
      type: 'pk_loot',
      valueGp: 43_188,
      itemId: 24598,
      npcId: null,
      subIndex: 0,
    });
  });

  it('death (dangerous): value from the merged lostItems, no killerNpcId for a player killer', () => {
    const row = only('event-death-dangerous');
    expect(row).toMatchObject({ type: 'death', valueGp: 34_906, itemId: null, npcId: null });
    // keptItems are not "lost": their value is not in valueGp.
    expect(row.valueGp).toBe((row.data as { data: { valueLost: number } }).data.valueLost);
  });

  it('death (safe): lostItems [] → value 0', () => {
    expect(only('event-death-safe')).toMatchObject({ type: 'death', valueGp: 0, npcId: null });
  });

  it('levelUp: one row per element, subIndex = original index (HashMap order kept), Combat kept', () => {
    const name = 'event-levelup-multi';
    const { events, skipped } = normalizeEvents(rawEvents(name), recvFor(name));
    expect(skipped).toBe(0);
    expect(events.map((e) => [e.subIndex, e.skill, e.level])).toEqual([
      [0, 'Hitpoints', 84],
      [1, 'Combat', 101],
      [2, 'Strength', 85],
    ]);
    for (const e of events) {
      expect(e).toMatchObject({
        pluginEventId: 'b6e8770a-39bf-468d-9752-819d843cd576',
        type: 'level_up',
        occurredAt: new Date(1790014400305),
        valueGp: null,
        itemId: null,
        npcId: null,
        tier: null,
        points: null,
      });
      expect(e.data).toEqual(rawEvents(name)[0]!.raw);
    }
  });

  it('collectionLog: value and item id', () => {
    expect(only('event-collectionlog')).toMatchObject({
      type: 'collection_log',
      valueGp: 10_221_949,
      itemId: 12922,
      npcId: null,
    });
  });

  it('collectionLog unresolved: itemId -1 → null, value 0', () => {
    expect(only('event-collectionlog-unresolved')).toMatchObject({
      type: 'collection_log',
      valueGp: 0,
      itemId: null,
    });
  });

  it('superiorSpawn: npc id', () => {
    expect(only('event-superior')).toMatchObject({
      type: 'superior_spawn',
      npcId: 7411,
      valueGp: null,
      itemId: null,
    });
  });

  it('achievementDiary: identical repeats with different ids are both kept', () => {
    const name = 'event-diary-repeat';
    const { events } = normalizeEvents(rawEvents(name), recvFor(name));
    expect(events).toHaveLength(2);
    expect(events.map((e) => [e.type, e.tier, e.subIndex])).toEqual([
      ['achievement_diary', 'easy', 0],
      ['achievement_diary', 'easy', 0],
    ]);
    expect(events[0]!.pluginEventId).not.toBe(events[1]!.pluginEventId);
    expect(events[0]!.occurredAt).toEqual(new Date(1790019802104));
    expect(events[1]!.occurredAt).toEqual(new Date(1790019819950));
  });

  it('combatTask: tier and points from the untrimmed task name', () => {
    expect(only('event-combattask')).toMatchObject({
      type: 'combat_task',
      tier: 'grandmaster',
      points: 6,
    });
  });

  it('unknown types are stored as sent, with no columns', () => {
    const row = only('event-unknown-type');
    expect(row).toMatchObject({
      type: 'questComplete',
      subIndex: 0,
      valueGp: null,
      itemId: null,
      npcId: null,
      skill: null,
      level: null,
      tier: null,
      points: null,
    });
    expect(row.data).toEqual(rawEvents('event-unknown-type')[0]!.raw);
  });

  it('a byte-identical resend (retry-duplicate-a/b) normalizes to the same dedupe key', () => {
    const a = normalizeEvents(rawEvents('retry-duplicate-a'), recvFor('retry-duplicate-a')).events;
    const b = normalizeEvents(
      rawEvents('retry-duplicate-b'),
      new Date(recvFor('retry-duplicate-a').getTime() + 40_000),
    ).events;
    expect(a).toHaveLength(1);
    expect(b.map((e) => [e.pluginEventId, e.subIndex])).toEqual(
      a.map((e) => [e.pluginEventId, e.subIndex]),
    );
  });

  it('snapshot-only payloads normalize to nothing', () => {
    expect(normalizeEvents(rawEvents('snapshot-normal'), recv)).toEqual({
      events: [],
      shutdown: null,
      skipped: 0,
    });
  });
});

describe('normalizeEvents: clientShutdown', () => {
  it.each([
    ['logout', 'logout'],
    ['shutdown', 'shutdown'],
    ['disabled-login-screen', 'disabled'],
    ['logout-client-start-no-player', 'logout'],
  ] as const)('%s → %s, not a row', (name, reason) => {
    const events = rawEvents(name);
    const result = normalizeEvents(events, recvFor(name));
    expect(result.events).toEqual([]);
    expect(result.skipped).toBe(0);
    expect(result.shutdown).toEqual({ reason, occurredAt: new Date(events[0]!.timestamp!) });
  });

  it('unknown strings and non-string data → shutdown', () => {
    const odd = [
      'Crash',
      'logout',
      '',
      'toString',
      '__proto__',
      42,
      null,
      { reason: 'Logout' },
      ['Logout'],
    ];
    for (const data of odd) {
      expect(normalizeEvents([ev('clientShutdown', data)], recv).shutdown?.reason).toBe('shutdown');
    }
  });

  it('the last one wins', () => {
    const result = normalizeEvents(
      [
        ev('clientShutdown', 'Disabled', { eventId: 'a', timestamp: R - 3000 }),
        ev('loot', { items: [] }),
        ev('clientShutdown', 'Logout', { eventId: 'b', timestamp: R - 2000 }),
      ],
      recv,
    );
    expect(result.shutdown).toEqual({ reason: 'logout', occurredAt: new Date(R - 2000) });
    expect(result.events.map((e) => e.type)).toEqual(['loot']);
  });

  it('needs no eventId and clamps its time', () => {
    const result = normalizeEvents(
      [ev('clientShutdown', 'Shutdown', { eventId: '', timestamp: R + 60_000 })],
      recv,
    );
    expect(result.shutdown).toEqual({ reason: 'shutdown', occurredAt: recv });
    expect(result.skipped).toBe(0);
  });
});

describe('normalizeEvents: occurredAt', () => {
  it('is clamped to [recv − 15 min, recv]', () => {
    const rows = normalizeEvents(
      [
        ev('loot', {}, { eventId: 'future', timestamp: R + 3_600_000 }),
        ev('loot', {}, { eventId: 'old', timestamp: R - 3_600_000 }),
        ev('loot', {}, { eventId: 'inside', timestamp: R - 5000 }),
        ev('loot', {}, { eventId: 'none', timestamp: null }),
      ],
      recv,
    ).events;
    expect(rows.map((r) => r.occurredAt)).toEqual([
      recv,
      new Date(R - EVENT_CLAMP_MS),
      new Date(R - 5000),
      recv,
    ]);
  });
});

describe('normalizeEvents: levelUp edge cases', () => {
  it('skips and counts invalid elements, keeping the original index of the valid ones', () => {
    const result = normalizeEvents(
      [
        ev('levelUp', [
          { skill: 'Attack', level: 50 },
          { skill: 'Defence' },
          null,
          'Strength',
          { skill: '', level: 5 },
          { skill: '   ', level: 5 },
          { skill: 42, level: 5 },
          { skill: 'Magic', level: 5.5 },
          { skill: 'Magic', level: '60' },
          { skill: 'Magic', level: 40_000 },
          { skill: 'Magic', level: Number.NaN },
          { skill: ' Mining ', level: 99 },
        ]),
      ],
      recv,
    );
    expect(result.skipped).toBe(10);
    expect(result.events.map((e) => [e.subIndex, e.skill, e.level])).toEqual([
      [0, 'Attack', 50],
      [11, 'Mining', 99],
    ]);
  });

  it('skips a non-array levelUp as one event', () => {
    for (const data of [{ skill: 'Attack', level: 50 }, 'Attack 50', null, 5]) {
      expect(normalizeEvents([ev('levelUp', data)], recv)).toEqual({
        events: [],
        shutdown: null,
        skipped: 1,
      });
    }
  });

  it('an empty levelUp array gives no rows and skips nothing', () => {
    expect(normalizeEvents([ev('levelUp', [])], recv)).toEqual({
      events: [],
      shutdown: null,
      skipped: 0,
    });
  });

  it('skips elements past index 63: sub_index is a smallint, and each row stores the whole event', () => {
    // 40,000 junk elements then a valid one: its index would overflow the smallint sub_index
    // (a deterministic insert failure), and every valid element would copy the whole array.
    const junk: unknown[] = new Array<number>(40_000).fill(0);
    junk.push({ skill: 'Attack', level: 5 });
    const huge = normalizeEvents([ev('levelUp', junk)], recv);
    expect(huge.events.map((e) => e.subIndex)).toEqual([]);
    expect(huge.skipped).toBe(40_001);

    const many = Array.from({ length: 70 }, (_, i) => ({ skill: `Skill ${i}`, level: 2 }));
    const result = normalizeEvents([ev('levelUp', many)], recv);
    expect(result.skipped).toBe(6);
    expect(result.events).toHaveLength(64);
    expect(result.events.at(-1)).toMatchObject({ subIndex: 63, skill: 'Skill 63' });
  });

  it('keeps virtual levels, Combat and repeated skills', () => {
    const rows = normalizeEvents(
      [
        ev('levelUp', [
          { skill: 'Attack', level: 127 },
          { skill: 'Combat', level: 126 },
          { skill: 'Attack', level: 126 },
        ]),
      ],
      recv,
    ).events;
    expect(rows.map((e) => [e.subIndex, e.skill, e.level])).toEqual([
      [0, 'Attack', 127],
      [1, 'Combat', 126],
      [2, 'Attack', 126],
    ]);
  });
});

describe('normalizeEvents: values and ids', () => {
  it('loot falls back to totalValue, then null', () => {
    const [a, b, c] = normalizeEvents(
      [
        ev('loot', { items: 'x', totalValue: 5000 }, { eventId: 'a' }),
        ev('pkLoot', { totalValue: 7000 }, { eventId: 'b' }),
        ev('loot', { totalValue: '5000' }, { eventId: 'c' }),
      ],
      recv,
    ).events;
    expect([a!.valueGp, b!.valueGp, c!.valueGp]).toEqual([5000, 7000, null]);
  });

  it('loot prefers the recomputed items value over totalValue, clamped to MAX_SAFE_INTEGER', () => {
    const [a, b, c] = normalizeEvents(
      [
        ev('loot', { items: [{ gePrice: 10, quantity: 3 }], totalValue: 999 }, { eventId: 'a' }),
        ev('pkLoot', { items: [], totalValue: 999 }, { eventId: 'b' }),
        ev('loot', { items: [{ gePrice: 2 ** 40, quantity: 2 ** 31 - 1 }] }, { eventId: 'c' }),
      ],
      recv,
    ).events;
    expect([a!.valueGp, b!.valueGp, c!.valueGp]).toEqual([30, 0, Number.MAX_SAFE_INTEGER]);
  });

  it('uses totalValue / valueLost when an item entry is malformed (a partial sum would be wrong)', () => {
    const rows = normalizeEvents(
      [
        // A renamed price field would otherwise turn every loot into 0 gp.
        ev(
          'loot',
          { items: [{ id: 4151, price: 1_500_000, quantity: 1 }], totalValue: 1_500_000 },
          { eventId: 'a' },
        ),
        ev(
          'pkLoot',
          {
            items: [
              { gePrice: 100, quantity: 2 },
              { gePrice: 1.5, quantity: 1 },
            ],
            totalValue: 202,
          },
          { eventId: 'b' },
        ),
        ev(
          'death',
          { lostItems: [null, { gePrice: 5, quantity: 1 }], valueLost: 7 },
          { eventId: 'c' },
        ),
        ev('loot', { items: [{ gePrice: '100', quantity: 1 }] }, { eventId: 'd' }),
      ],
      recv,
    ).events;
    expect(rows.map((r) => r.valueGp)).toEqual([1_500_000, 202, 7, null]);
  });

  it('death falls back to valueLost; killerNpcId becomes npcId', () => {
    const row = normalizeEvents(
      [ev('death', { valueLost: 1234, killerName: 'Vorkath', killerNpcId: 8061 })],
      recv,
    ).events[0]!;
    expect(row).toMatchObject({ valueGp: 1234, npcId: 8061, itemId: null });
  });

  it('clamps fallback values to [0, MAX_SAFE_INTEGER] and nulls non-integers', () => {
    const rows = normalizeEvents(
      [
        ev('loot', { totalValue: 1e20 }, { eventId: 'a' }),
        ev('death', { valueLost: -5 }, { eventId: 'b' }),
        ev('collectionLog', { value: 12.5 }, { eventId: 'c' }),
        ev('collectionLog', { value: Number.POSITIVE_INFINITY }, { eventId: 'd' }),
      ],
      recv,
    ).events;
    expect(rows.map((r) => r.valueGp)).toEqual([Number.MAX_SAFE_INTEGER, 0, null, null]);
  });

  it('nulls ids that are not int32 integers, and negative collection-log ids', () => {
    const rows = normalizeEvents(
      [
        ev('loot', { highestValueItem: { id: 4151.5 }, npcId: 2 ** 31 }, { eventId: 'a' }),
        ev('loot', { highestValueItem: 4151, npcId: '3162' }, { eventId: 'b' }),
        ev('superiorSpawn', { npcId: -2_147_483_648 }, { eventId: 'c' }),
        ev('collectionLog', { itemId: -1 }, { eventId: 'd' }),
        ev('collectionLog', { itemId: -7 }, { eventId: 'e' }),
        ev('collectionLog', { itemId: 0 }, { eventId: 'f' }),
      ],
      recv,
    ).events;
    expect(rows.map((r) => [r.itemId, r.npcId])).toEqual([
      [null, null],
      [null, null],
      [null, -2_147_483_648],
      [null, null],
      [null, null],
      [0, null],
    ]);
  });

  it('tiers are lowercased and trimmed; blank or non-string tiers are null', () => {
    const rows = normalizeEvents(
      [
        ev('achievementDiary', { tier: '  HARD ', region: 'Varrock' }, { eventId: 'a' }),
        ev('achievementDiary', { tier: '   ' }, { eventId: 'b' }),
        ev('combatTask', { tier: 3, taskName: 'X (2 points).' }, { eventId: 'c' }),
        ev('combatTask', { tier: 'Elite', taskName: 'No suffix' }, { eventId: 'd' }),
      ],
      recv,
    ).events;
    expect(rows.map((r) => [r.tier, r.points])).toEqual([
      ['hard', null],
      [null, null],
      [null, 2],
      ['elite', null],
    ]);
  });

  it('combat-task points outside smallint become null', () => {
    const row = normalizeEvents(
      [ev('combatTask', { tier: 'easy', taskName: 'X (40000 points).' })],
      recv,
    ).events[0]!;
    expect(row.points).toBeNull();
  });

  it('known types with non-object data are kept with null columns (never throws)', () => {
    const types = [
      'loot',
      'pkLoot',
      'death',
      'collectionLog',
      'superiorSpawn',
      'achievementDiary',
      'combatTask',
    ];
    for (const data of [null, 'text', 42, [1, 2], undefined]) {
      const result = normalizeEvents(
        types.map((t) => ev(t, data, { eventId: `${t}-x` })),
        recv,
      );
      expect(result.skipped).toBe(0);
      expect(result.events).toHaveLength(types.length);
      for (const row of result.events) {
        expect([
          row.valueGp,
          row.itemId,
          row.npcId,
          row.skill,
          row.level,
          row.tier,
          row.points,
        ]).toEqual([null, null, null, null, null, null, null]);
      }
    }
  });

  it('only the plugin type names map; a stored name sent as a type is kept as is without columns', () => {
    const row = normalizeEvents([ev('pk_loot', { totalValue: 5 })], recv).events[0]!;
    expect(row).toMatchObject({ type: 'pk_loot', valueGp: null });
  });

  it('keeps payload order across types', () => {
    const rows = normalizeEvents(
      [
        ev('superiorSpawn', {}, { eventId: '1' }),
        ev('levelUp', [{ skill: 'Slayer', level: 90 }], { eventId: '2' }),
        ev('loot', {}, { eventId: '3' }),
      ],
      recv,
    ).events;
    expect(rows.map((r) => r.type)).toEqual(['superior_spawn', 'level_up', 'loot']);
  });
});

describe('normalizeEvents: NUL characters and ids', () => {
  it('removes NUL from data strings and keys without touching the input', () => {
    const raw = {
      type: 'loot',
      data: {
        'so\u0000urce': { text: 'Kree\u0000arra' },
        items: [{ name: 'a\u0000b', gePrice: 1, quantity: 1 }],
      },
      eventId: 'id-1',
      timestamp: R,
      extra: 'x\u0000',
    };
    const row = normalizeEvents([event(raw)], recv).events[0]!;
    expect(row.data).toEqual({
      type: 'loot',
      data: { source: { text: 'Kreearra' }, items: [{ name: 'ab', gePrice: 1, quantity: 1 }] },
      eventId: 'id-1',
      timestamp: R,
      extra: 'x',
    });
    expect(JSON.stringify(row.data)).not.toContain('\\u0000');
    expect(raw.extra).toBe('x\u0000');
  });

  it('keeps unknown fields of the raw event (not a zod output)', () => {
    const raw = {
      type: 'loot',
      data: { items: [], futureField: { a: 1 } },
      eventId: 'id',
      timestamp: R,
      v: 2,
    };
    expect(normalizeEvents([event(raw)], recv).events[0]!.data).toEqual(raw);
  });

  it('removes NUL from the text columns too (Postgres text rejects it)', () => {
    const rows = normalizeEvents(
      [
        ev('levelUp', [{ skill: 'Att\u0000ack', level: 50 }], { eventId: 'lvl\u0000-1' }),
        ev('achievementDiary', { tier: 'ea\u0000sy' }, { eventId: 'd' }),
        ev('quest\u0000Complete', {}, { eventId: 'q' }),
      ],
      recv,
    ).events;
    expect(rows.map((r) => [r.pluginEventId, r.type, r.skill, r.tier])).toEqual([
      ['lvl-1', 'level_up', 'Attack', null],
      ['d', 'achievement_diary', null, 'easy'],
      ['q', 'questComplete', null, null],
    ]);
  });

  it('replaces lone surrogates in the text columns, as parsePayload leaves them to it (DB-1)', () => {
    const rows = normalizeEvents(
      [
        ev('levelUp', [{ skill: 'Att\uD800ack', level: 50 }], { eventId: 'id\uDC00' }),
        ev('achievementDiary', { tier: 'easy\uDBFF' }, { eventId: 'd' }),
        ev('quest\uDFFF', {}, { eventId: 'q' }),
        ev('loot', {}, { eventId: '😀' }),
      ],
      recv,
    ).events;
    expect(rows.map((r) => [r.pluginEventId, r.type, r.skill, r.tier])).toEqual([
      ['id�', 'level_up', 'Att�ack', null],
      ['d', 'achievement_diary', null, 'easy�'],
      ['q', 'quest�', null, null],
      // A valid pair (an emoji) is kept.
      ['😀', 'loot', null, null],
    ]);
    // data too: JSON.stringify would write a lone surrogate as an escape jsonb rejects.
    expect(rows[0]!.data).toMatchObject({ eventId: 'id�', data: [{ skill: 'Att�ack' }] });
  });

  it('cleans the type before dispatching on it: a stored known name always gets its columns', () => {
    const result = normalizeEvents(
      [
        ev('lo\u0000ot', { items: [{ gePrice: 10, quantity: 3 }] }, { eventId: 'a' }),
        ev('level\u0000Up', [{ skill: 'Attack', level: 50 }], { eventId: 'b' }),
        ev('client\u0000Shutdown', 'Logout', { eventId: 'c' }),
      ],
      recv,
    );
    expect(result.events.map((r) => [r.type, r.valueGp, r.skill, r.level])).toEqual([
      ['loot', 30, null, null],
      ['level_up', null, 'Attack', 50],
    ]);
    expect(result.shutdown?.reason).toBe('logout');
  });

  it('skips and counts events without a usable eventId', () => {
    const result = normalizeEvents(
      [
        ev('loot', {}, { eventId: '' }),
        ev('loot', {}, { eventId: '\u0000\u0000' }),
        ev('loot', {}, { eventId: 42 as unknown as string }),
        ev('loot', {}, { eventId: 'ok' }),
      ],
      recv,
    );
    expect(result.skipped).toBe(3);
    expect(result.events.map((e) => e.pluginEventId)).toEqual(['ok']);
  });
});
