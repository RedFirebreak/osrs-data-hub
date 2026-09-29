import { fixtureJson } from '@hub/fixtures';
import { describe, expect, it } from 'vitest';
import { SPECIAL_WORLD_TYPES, isSpecialWorld } from './worlds';

describe('isSpecialWorld', () => {
  it('is false for nothing or regular worlds', () => {
    expect(isSpecialWorld(undefined)).toBe(false);
    expect(isSpecialWorld(null)).toBe(false);
    expect(isSpecialWorld([])).toBe(false);
    expect(isSpecialWorld(['MEMBERS'])).toBe(false);
    expect(
      isSpecialWorld(['MEMBERS', 'PVP', 'HIGH_RISK', 'SKILL_TOTAL', 'LAST_MAN_STANDING']),
    ).toBe(false);
  });

  it('is true when any type is special', () => {
    for (const type of SPECIAL_WORLD_TYPES) {
      expect(isSpecialWorld([type])).toBe(true);
      expect(isSpecialWorld(['MEMBERS', type])).toBe(true);
    }
  });

  it('matches names exactly (case-sensitive, as RuneLite sends them)', () => {
    expect(isSpecialWorld(['seasonal'])).toBe(false);
    expect(isSpecialWorld(['SEASONAL '])).toBe(false);
  });

  it('holds the plugin set (WorldUtils.java:29)', () => {
    expect([...SPECIAL_WORLD_TYPES].sort()).toEqual([
      'BETA_WORLD',
      'DEADMAN',
      'NOSAVE_MODE',
      'PVP_ARENA',
      'QUEST_SPEEDRUNNING',
      'SEASONAL',
      'TOURNAMENT_WORLD',
    ]);
  });

  it('classifies the fixtures by payload worldTypes', () => {
    type P = { player: { worldTypes: string[] } };
    expect(isSpecialWorld(fixtureJson<P>('special-world-seasonal').player.worldTypes)).toBe(true);
    // The stale hop payload still carries SEASONAL although the client is on a normal world now.
    expect(isSpecialWorld(fixtureJson<P>('hop-from-special-world-stale').player.worldTypes)).toBe(
      true,
    );
    expect(isSpecialWorld(fixtureJson<P>('snapshot-normal').player.worldTypes)).toBe(false);
    expect(isSpecialWorld(fixtureJson<P>('snapshot-world-hop').player.worldTypes)).toBe(false);
  });
});
