import { describe, expect, it } from 'vitest';
import { describeEvent } from './describe';
import {
  EVENT_TYPES,
  KNOWN_EVENT_TYPES,
  LOOT_EVENT_TYPES,
  eventTypeTitle,
  isKnownEventType,
  isLootEvent,
  knownPluginEventType,
  storedEventType,
} from './types';

describe('event type table', () => {
  it('lists the stored names in the order the filters show them', () => {
    expect(KNOWN_EVENT_TYPES).toEqual([
      'loot',
      'pk_loot',
      'death',
      'level_up',
      'collection_log',
      'superior_spawn',
      'achievement_diary',
      'combat_task',
    ]);
    expect(LOOT_EVENT_TYPES).toEqual(['loot', 'pk_loot']);
  });

  it('gives every type a plugin name of its own', () => {
    const plugin = KNOWN_EVENT_TYPES.map((type) => EVENT_TYPES[type].plugin);
    expect(new Set(plugin).size).toBe(KNOWN_EVENT_TYPES.length);
  });

  it('maps plugin names to stored names and leaves anything else alone', () => {
    expect(storedEventType('levelUp')).toBe('level_up');
    expect(storedEventType('pkLoot')).toBe('pk_loot');
    expect(storedEventType('loot')).toBe('loot');
    expect(storedEventType('level_up')).toBe('level_up');
    expect(storedEventType('questComplete')).toBe('questComplete');
    expect(storedEventType('constructor')).toBe('constructor');
    expect(storedEventType('__proto__')).toBe('__proto__');
  });

  it('knows a type by its plugin name only when asked for the plugin name', () => {
    expect(knownPluginEventType('levelUp')).toBe('level_up');
    expect(knownPluginEventType('loot')).toBe('loot');
    expect(knownPluginEventType('level_up')).toBeUndefined();
    expect(knownPluginEventType('toString')).toBeUndefined();
  });

  it('knows stored names, not plugin names or prototype keys', () => {
    expect(isKnownEventType('level_up')).toBe(true);
    expect(isKnownEventType('levelUp')).toBe(false);
    expect(isKnownEventType('constructor')).toBe(false);
    expect(isKnownEventType('__proto__')).toBe(false);
  });

  it('tells loot types from the rest', () => {
    expect(isLootEvent('loot')).toBe(true);
    expect(isLootEvent('pk_loot')).toBe(true);
    expect(isLootEvent('pkLoot')).toBe(false);
    expect(isLootEvent('death')).toBe(false);
    expect(isLootEvent('questComplete')).toBe(false);
  });

  it('titles a type the way describeEvent does', () => {
    expect(eventTypeTitle('level_up')).toBe('Level up');
    expect(eventTypeTitle('pk_loot')).toBe('Loot chest');
    expect(eventTypeTitle('questComplete')).toBe('questComplete');
    expect(eventTypeTitle('constructor')).toBe('constructor');
    const blank = { valueGp: null, skill: null, level: null, tier: null, points: null, data: null };
    for (const type of KNOWN_EVENT_TYPES) {
      const described = describeEvent('Zezima', { type, ...blank });
      expect(described.title).toBe(eventTypeTitle(type));
      expect(described.icon).toBe(EVENT_TYPES[type].icon);
    }
  });
});
