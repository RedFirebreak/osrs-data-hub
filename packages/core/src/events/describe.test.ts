import { fixtureJson, type FixtureName } from '@hub/fixtures';
import { describe, expect, it } from 'vitest';
import type { RawEvent } from '../payload/types';
import { describeEvent, type DescribableEvent } from './describe';
import { normalizeEvents } from './normalize';

interface Body {
  player: { name: string };
  events: Record<string, unknown>[];
  timestamp: number;
}

/** Describes every stored row of a fixture's events, as the feed would (account name from the fixture). */
function describeFixture(name: FixtureName) {
  const body = fixtureJson<Body>(name);
  const raws: RawEvent[] = body.events.map((raw) => ({
    type: raw.type as string,
    data: raw.data,
    eventId: raw.eventId as string,
    timestamp: raw.timestamp as number,
    raw,
  }));
  const rows = normalizeEvents(raws, new Date(body.timestamp + 1000)).events;
  return rows.map((row) => describeEvent(body.player.name, row));
}

function row(
  type: string,
  data: unknown,
  columns: Partial<DescribableEvent> = {},
): DescribableEvent {
  return {
    type,
    valueGp: null,
    skill: null,
    level: null,
    tier: null,
    points: null,
    data,
    ...columns,
  };
}

/** A stored event envelope around `data`. */
function stored(type: string, data: unknown): Record<string, unknown> {
  return { type, data, eventId: 'e1', timestamp: 1790000000000 };
}

describe('describeEvent: fixtures', () => {
  it('loot', () => {
    expect(describeFixture('event-loot')).toEqual([
      {
        title: 'Loot',
        line: "Zezima received Armadyl chestplate (35.2M) from Kree'arra",
        icon: 'gift',
      },
    ]);
  });

  it('pk loot', () => {
    expect(describeFixture('event-pkloot')).toEqual([
      { title: 'Loot chest', line: 'Lynx Titan opened a loot chest worth 43.2K', icon: 'gift' },
    ]);
  });

  it('dangerous death with a killer', () => {
    expect(describeFixture('event-death-dangerous')).toEqual([
      {
        title: 'Death',
        line: 'Iron Mira was killed by Lynx Titan (inventory value lost: 34.9K)',
        icon: 'skull',
      },
    ]);
  });

  it('safe death without a killer', () => {
    expect(describeFixture('event-death-safe')).toEqual([
      { title: 'Death', line: 'Zezima died (safe death)', icon: 'skull' },
    ]);
  });

  it('multi level-up: one line per row, Combat worded as combat level', () => {
    expect(describeFixture('event-levelup-multi')).toEqual([
      { title: 'Level up', line: 'Iron Mira reached level 84 Hitpoints', icon: 'trending-up' },
      { title: 'Level up', line: 'Iron Mira reached combat level 101', icon: 'trending-up' },
      { title: 'Level up', line: 'Iron Mira reached level 85 Strength', icon: 'trending-up' },
    ]);
  });

  it('collection log (resolved and unresolved)', () => {
    expect(describeFixture('event-collectionlog')).toEqual([
      {
        title: 'Collection log',
        line: 'Iron Mira: new collection log item Tanzanite fang',
        icon: 'book',
      },
    ]);
    expect(describeFixture('event-collectionlog-unresolved')[0]!.line).toBe(
      'Iron Mira: new collection log item Abyssal protector',
    );
  });

  it('superior spawn', () => {
    expect(describeFixture('event-superior')).toEqual([
      {
        title: 'Superior spawn',
        line: 'A superior Nechryarch spawned for Zezima',
        icon: 'sparkles',
      },
    ]);
  });

  it('achievement diary (repeats described alike)', () => {
    expect(describeFixture('event-diary-repeat')).toEqual([
      {
        title: 'Achievement diary',
        line: 'Iron Mira completed an Easy Varrock diary task',
        icon: 'map',
      },
      {
        title: 'Achievement diary',
        line: 'Iron Mira completed an Easy Varrock diary task',
        icon: 'map',
      },
    ]);
  });

  it('combat task', () => {
    expect(describeFixture('event-combattask')).toEqual([
      {
        title: 'Combat task',
        line: 'Zezima completed a Grandmaster combat task: No Pressure (6 points)',
        icon: 'swords',
      },
    ]);
  });

  it('unknown type', () => {
    expect(describeFixture('event-unknown-type')).toEqual([
      { title: 'questComplete', line: 'Zezima: questComplete', icon: 'bell' },
    ]);
  });
});

describe('describeEvent: loot', () => {
  it('shows a stack size, valueGp over totalValue, and falls back to totalValue', () => {
    const data = stored('loot', {
      highestValueItem: { name: 'Coins', quantity: 125_000 },
      totalValue: 1,
      source: { text: 'Lynx Titan' },
    });
    expect(describeEvent('Zezima', row('loot', data, { valueGp: 125_000 })).line).toBe(
      'Zezima received 125,000 x Coins (125K) from Lynx Titan',
    );
    expect(describeEvent('Zezima', row('loot', data)).line).toBe(
      'Zezima received 125,000 x Coins (1) from Lynx Titan',
    );
  });

  it('degrades without item, value or source', () => {
    expect(describeEvent('Zezima', row('loot', stored('loot', {}))).line).toBe(
      'Zezima received loot',
    );
    expect(
      describeEvent('Zezima', row('loot', stored('loot', { source: 'Vorkath' }), { valueGp: 0 }))
        .line,
    ).toBe('Zezima received loot (0)');
    expect(
      describeEvent(
        'Zezima',
        row(
          'loot',
          stored('loot', { highestValueItem: { name: 'Dragon warhammer', quantity: 1 } }),
          { valueGp: 38_200_000 },
        ),
      ).line,
    ).toBe('Zezima received Dragon warhammer (38.2M)');
  });

  it('pk loot without a value', () => {
    expect(describeEvent('Lynx Titan', row('pk_loot', null)).line).toBe(
      'Lynx Titan opened a loot chest',
    );
  });
});

describe('describeEvent: death', () => {
  it('ignores the "?" killer and describes a dangerous death without one', () => {
    const data = stored('death', { danger: 'DANGEROUS', killerName: '?', valueLost: 34_906 });
    expect(describeEvent('Zezima', row('death', data, { valueGp: 34_906 })).line).toBe(
      'Zezima died (inventory value lost: 34.9K)',
    );
    expect(describeEvent('Zezima', row('death', data)).line).toBe(
      'Zezima died (inventory value lost: 34.9K)',
    );
  });

  it('exceptional deaths lose nothing', () => {
    const data = stored('death', { danger: 'EXCEPTIONAL', killerName: 'TzKal-Zuk', valueLost: 0 });
    expect(describeEvent('Zezima', row('death', data, { valueGp: 0 })).line).toBe(
      'Zezima was killed by TzKal-Zuk (safe death)',
    );
  });

  it('works on redacted data (location stripped) and without data', () => {
    const redacted = stored('death', { danger: 'DANGEROUS', killerName: 'Vorkath', lostItems: [] });
    expect(describeEvent('Zezima', row('death', redacted, { valueGp: 0 })).line).toBe(
      'Zezima was killed by Vorkath (inventory value lost: 0)',
    );
    expect(describeEvent('Zezima', row('death', null)).line).toBe('Zezima died');
  });
});

describe('describeEvent: level up', () => {
  it('uses the columns first', () => {
    const data = stored('levelUp', [
      { skill: 'Hitpoints', level: 84 },
      { skill: 'Strength', level: 85 },
    ]);
    expect(
      describeEvent('Zezima', row('level_up', data, { skill: 'Strength', level: 85 })).line,
    ).toBe('Zezima reached level 85 Strength');
    expect(
      describeEvent('Zezima', row('level_up', data, { skill: 'Attack', level: 99 })).line,
    ).toBe('Zezima reached level 99 Attack');
  });

  it('falls back to a one-element levelUp array only', () => {
    const one = stored('levelUp', [{ skill: 'Slayer', level: 90 }]);
    expect(describeEvent('Zezima', row('level_up', one)).line).toBe(
      'Zezima reached level 90 Slayer',
    );
    const two = stored('levelUp', [
      { skill: 'Slayer', level: 90 },
      { skill: 'Combat', level: 100 },
    ]);
    expect(describeEvent('Zezima', row('level_up', two)).line).toBe('Zezima gained a level');
  });

  it('handles partial columns', () => {
    expect(describeEvent('Zezima', row('level_up', null, { skill: 'Mining' })).line).toBe(
      'Zezima gained a Mining level',
    );
    expect(describeEvent('Zezima', row('level_up', null, { level: 50 })).line).toBe(
      'Zezima reached level 50',
    );
    expect(describeEvent('Zezima', row('level_up', null, { skill: 'Combat' })).line).toBe(
      'Zezima gained a combat level',
    );
    expect(describeEvent('Zezima', row('level_up', null, { skill: 'combat', level: 3 })).line).toBe(
      'Zezima reached combat level 3',
    );
  });
});

describe('describeEvent: diary and combat task', () => {
  it('picks "a" or "an" from the capitalized tier', () => {
    const line = (tier: string) =>
      describeEvent(
        'Zezima',
        row('achievement_diary', stored('achievementDiary', { tier, region: 'Kandarin' })),
      ).line;
    expect(line('easy')).toBe('Zezima completed an Easy Kandarin diary task');
    expect(line('MEDIUM')).toBe('Zezima completed a Medium Kandarin diary task');
    expect(line('hard')).toBe('Zezima completed a Hard Kandarin diary task');
    expect(line('elite')).toBe('Zezima completed an Elite Kandarin diary task');
  });

  it('the tier column wins; either part may be missing', () => {
    const data = stored('achievementDiary', { tier: 'easy', region: 'Ardougne' });
    expect(describeEvent('Zezima', row('achievement_diary', data, { tier: 'hard' })).line).toBe(
      'Zezima completed a Hard Ardougne diary task',
    );
    expect(
      describeEvent('Zezima', row('achievement_diary', stored('x', { region: 'Ardougne' }))).line,
    ).toBe('Zezima completed an Ardougne diary task');
    expect(
      describeEvent('Zezima', row('achievement_diary', stored('x', { tier: 'elite' }))).line,
    ).toBe('Zezima completed an Elite diary task');
    expect(describeEvent('Zezima', row('achievement_diary', 'garbage')).line).toBe(
      'Zezima completed a diary task',
    );
  });

  it('combat task: singular point, points column wins, missing parts left out', () => {
    const one = stored('combatTask', { tier: 'easy', taskName: ' Noxious Foe (1 point).' });
    expect(describeEvent('Zezima', row('combat_task', one, { tier: 'easy', points: 1 })).line).toBe(
      'Zezima completed an Easy combat task: Noxious Foe (1 point)',
    );
    expect(describeEvent('Zezima', row('combat_task', one, { points: 2 })).line).toBe(
      'Zezima completed an Easy combat task: Noxious Foe (2 points)',
    );
    expect(describeEvent('Zezima', row('combat_task', null, { tier: 'master' })).line).toBe(
      'Zezima completed a Master combat task',
    );
    expect(
      describeEvent('Zezima', row('combat_task', stored('combatTask', { taskName: 'Task.' }))).line,
    ).toBe('Zezima completed a combat task: Task');
  });
});

describe('describeEvent: robustness', () => {
  const types = [
    'loot',
    'pk_loot',
    'death',
    'level_up',
    'collection_log',
    'superior_spawn',
    'achievement_diary',
    'combat_task',
    'questComplete',
  ];
  const odd: unknown[] = [
    null,
    undefined,
    'string',
    42,
    [],
    [1, 2],
    {},
    { data: null },
    { data: 'x' },
    { data: [] },
    {
      data: {
        highestValueItem: 'x',
        source: 5,
        killerName: 7,
        danger: 3,
        tier: [],
        region: {},
        taskName: 9,
      },
    },
    {
      data: {
        highestValueItem: { name: 5, quantity: 'many' },
        source: { text: null },
        name: {},
        itemName: [],
      },
    },
  ];

  it('never throws and always starts with or mentions the account name', () => {
    for (const type of types) {
      for (const data of odd) {
        for (const valueGp of [null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
          const d = describeEvent('Zezima', row(type, data, { valueGp }));
          expect(d.line).toContain('Zezima');
          expect(d.title).not.toBe('');
          expect(d.line).not.toContain('undefined');
          expect(d.line).not.toContain('null');
          expect(d.line).not.toContain('NaN');
          expect(d.line).not.toContain('[object');
        }
      }
    }
  });

  it('accepts the plugin type names', () => {
    expect(describeEvent('Zezima', row('levelUp', null, { skill: 'Attack', level: 2 })).title).toBe(
      'Level up',
    );
    expect(describeEvent('Zezima', row('pkLoot', null)).title).toBe('Loot chest');
    expect(describeEvent('Zezima', row('superiorSpawn', null)).line).toBe(
      'A superior spawned for Zezima',
    );
    expect(describeEvent('Zezima', row('collectionLog', null)).line).toBe(
      'Zezima: new collection log item',
    );
  });

  it('does not treat inherited keys as known types', () => {
    expect(describeEvent('Zezima', row('toString', null))).toEqual({
      title: 'toString',
      line: 'Zezima: toString',
      icon: 'bell',
    });
  });

  it('cleans plugin text: control characters, whitespace runs and overlong names', () => {
    const data = stored('superiorSpawn', { name: '  Nech\nry\u0000arch\t  lord ' });
    expect(describeEvent('Zezima', row('superior_spawn', data)).line).toBe(
      'A superior Nech ry arch lord spawned for Zezima',
    );
    const long = 'x'.repeat(500);
    const line = describeEvent(
      'Zezima',
      row('collection_log', stored('collectionLog', { itemName: long })),
    ).line;
    expect(line).toBe(`Zezima: new collection log item ${'x'.repeat(99)}…`);
  });

  it('treats C1 controls and bidi overrides as control characters too', () => {
    // U+009B is a terminal CSI; U+202E/U+2066 reorder the rest of the line in the toast.
    const data = stored('superiorSpawn', { name: 'Nech‮ryarch\u009b31m' });
    expect(describeEvent('Zez⁦ima\u0085', row('superior_spawn', data)).line).toBe(
      'A superior Nech ryarch 31m spawned for Zez ima',
    );
  });

  it('shows a stack size only for a Java-int quantity', () => {
    const line = (quantity: unknown) =>
      describeEvent(
        'Zezima',
        row('loot', stored('loot', { highestValueItem: { name: 'Coins', quantity } })),
      ).line;
    expect(line(2)).toBe('Zezima received 2 x Coins');
    expect(line(2_147_483_647)).toBe('Zezima received 2,147,483,647 x Coins');
    for (const q of [1, 0, -5, 2.5, 1e300, 2 ** 31, '5']) {
      expect(line(q)).toBe('Zezima received Coins');
    }
  });

  it('ignores a level or points value that is not an integer', () => {
    expect(
      describeEvent('Zezima', row('level_up', null, { skill: 'Combat', level: 3.7 })).line,
    ).toBe('Zezima gained a combat level');
    expect(
      describeEvent(
        'Zezima',
        row('level_up', stored('levelUp', [{ skill: 'Slayer', level: 90.5 }])),
      ).line,
    ).toBe('Zezima gained a Slayer level');
    expect(
      describeEvent('Zezima', row('combat_task', null, { tier: 'easy', points: 2.5 })).line,
    ).toBe('Zezima completed an Easy combat task');
  });

  it('uses "Someone" for a blank account name', () => {
    expect(describeEvent('  ', row('superior_spawn', null)).line).toBe(
      'A superior spawned for Someone',
    );
  });

  it('describes a blank unknown type as "event"', () => {
    expect(describeEvent('Zezima', row('', null))).toEqual({
      title: 'event',
      line: 'Zezima: event',
      icon: 'bell',
    });
  });
});
