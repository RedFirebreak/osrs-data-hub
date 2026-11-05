import { describe, expect, it } from 'vitest';
import {
  formatEffectLeft,
  readStatusState,
  runningEffects,
  shiftStatusClock,
  statusAt,
  withoutWilderness,
  type StatusState,
} from './status';

const NOW = 1_790_000_000_000;
const state: StatusState = {
  runEnergy: 73,
  running: true,
  specialAttack: 50,
  poison: { type: 'venom', damage: 8 },
  wildernessLevel: 23,
  effects: [
    {
      id: 'divine_super_combat',
      name: 'Divine super combat',
      endsAt: NOW + 300_000,
      precision: 600,
    },
    { id: 'stamina', name: 'Stamina', endsAt: NOW - 1, precision: 6000 },
  ],
};

describe('status (D-143)', () => {
  it('drops an effect whose end has passed', () => {
    expect(runningEffects(state.effects, NOW).map((e) => e.id)).toEqual(['divine_super_combat']);
    expect(statusAt(state, NOW, true).effects).toHaveLength(1);
  });

  it('offline: nothing runs, no poison, no wilderness; run and special stay', () => {
    expect(statusAt(state, NOW, false)).toEqual({
      ...state,
      poison: { type: 'none', damage: null },
      wildernessLevel: null,
      effects: [],
    });
  });

  it('leaves the wilderness level out for a reader without the live location', () => {
    expect(withoutWilderness(state).wildernessLevel).toBeNull();
    expect(withoutWilderness(state).effects).toBe(state.effects);
  });

  it('moves end times by a clock offset', () => {
    expect(shiftStatusClock(state, 1000).effects[0]!.endsAt).toBe(NOW + 301_000);
    expect(shiftStatusClock(state, 0)).toBe(state);
  });

  it('formats the time left', () => {
    expect(formatEffectLeft(NOW + 9_999, NOW)).toBe('0:09');
    expect(formatEffectLeft(NOW + 245_000, NOW)).toBe('4:05');
    expect(formatEffectLeft(NOW + 3_723_000, NOW)).toBe('1:02:03');
    expect(formatEffectLeft(NOW - 5_000, NOW)).toBe('0:00');
  });

  it('reads a stored value back, and never throws on a wrong one', () => {
    expect(readStatusState(state)).toEqual(state);
    for (const bad of [null, 1, 'x', {}, { runEnergy: 101, specialAttack: 0 }]) {
      expect(readStatusState(bad)).toBeNull();
    }
    const odd = readStatusState({
      runEnergy: 1,
      specialAttack: 2,
      poison: { type: 'acid', damage: 3 },
      wildernessLevel: 0,
      effects: [{ id: 'BAD ID', endsAt: 1 }, { id: 'stamina', endsAt: 5 }, null],
    });
    expect(odd).toEqual({
      runEnergy: 1,
      running: false,
      specialAttack: 2,
      poison: { type: 'none', damage: null },
      wildernessLevel: null,
      effects: [{ id: 'stamina', name: 'stamina', endsAt: 5, precision: 0 }],
    });
  });
});
