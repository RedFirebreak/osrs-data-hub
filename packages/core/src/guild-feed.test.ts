import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GUILD_FEED_FILTER,
  inGuildFeed,
  isVirtualLevelUp,
  type GuildFeedFilter,
} from './guild-feed';

function ev(
  type: string,
  over: { valueGp?: number | null; skill?: string | null; level?: number | null } = {},
) {
  return { type, valueGp: null, skill: null, level: null, ...over };
}

function filter(over: Partial<GuildFeedFilter> = {}): GuildFeedFilter {
  return { ...DEFAULT_GUILD_FEED_FILTER, ...over };
}

describe('DEFAULT_GUILD_FEED_FILTER', () => {
  it('shows all loot and hides virtual levels (D-81)', () => {
    expect(DEFAULT_GUILD_FEED_FILTER).toEqual({ minLootValue: 0, showVirtualLevels: false });
    expect(inGuildFeed(ev('loot', { valueGp: 1 }), DEFAULT_GUILD_FEED_FILTER)).toBe(true);
    expect(inGuildFeed(ev('loot'), DEFAULT_GUILD_FEED_FILTER)).toBe(true);
    expect(
      inGuildFeed(ev('level_up', { skill: 'Attack', level: 100 }), DEFAULT_GUILD_FEED_FILTER),
    ).toBe(false);
  });
});

describe('isVirtualLevelUp', () => {
  it('is a skill level-up past 99', () => {
    expect(isVirtualLevelUp(ev('level_up', { skill: 'Attack', level: 99 }))).toBe(false);
    expect(isVirtualLevelUp(ev('level_up', { skill: 'Attack', level: 100 }))).toBe(true);
    expect(isVirtualLevelUp(ev('level_up', { skill: 'Sailing', level: 127 }))).toBe(true);
  });

  it('never counts combat level, whose maximum is 126', () => {
    expect(isVirtualLevelUp(ev('level_up', { skill: 'Combat', level: 126 }))).toBe(false);
  });

  it('is false for other types and for rows without a level', () => {
    expect(isVirtualLevelUp(ev('loot', { skill: 'Attack', level: 120 }))).toBe(false);
    expect(isVirtualLevelUp(ev('level_up', { skill: 'Attack', level: null }))).toBe(false);
  });
});

describe('inGuildFeed', () => {
  it('leaves out loot and PK loot below the minimum, a missing value counting as 0', () => {
    const f = filter({ minLootValue: 10_000 });
    for (const type of ['loot', 'pk_loot']) {
      expect(inGuildFeed(ev(type, { valueGp: 9_999 }), f)).toBe(false);
      expect(inGuildFeed(ev(type, { valueGp: 10_000 }), f)).toBe(true);
      expect(inGuildFeed(ev(type, { valueGp: null }), f)).toBe(false);
    }
  });

  it('never filters other types by value', () => {
    const f = filter({ minLootValue: 10_000 });
    expect(inGuildFeed(ev('collection_log', { valueGp: 1 }), f)).toBe(true);
    expect(inGuildFeed(ev('death', { valueGp: 1 }), f)).toBe(true);
    expect(inGuildFeed(ev('questComplete'), f)).toBe(true);
  });

  it('shows virtual levels only when allowed', () => {
    const virtual = ev('level_up', { skill: 'Fishing', level: 105 });
    expect(inGuildFeed(virtual, filter({ showVirtualLevels: false }))).toBe(false);
    expect(inGuildFeed(virtual, filter({ showVirtualLevels: true }))).toBe(true);
    expect(inGuildFeed(ev('level_up', { skill: 'Fishing', level: 99 }), filter())).toBe(true);
  });
});
