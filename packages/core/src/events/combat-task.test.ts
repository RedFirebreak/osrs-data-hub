import { fixtureJson } from '@hub/fixtures';
import { describe, expect, it } from 'vitest';
import { parseCombatTaskName } from './combat-task';

describe('parseCombatTaskName', () => {
  it('splits the untrimmed wire text from the fixture', () => {
    const data = fixtureJson<{ events: { data: { taskName: string } }[] }>('event-combattask')
      .events[0]!.data;
    expect(data.taskName).toBe(' No Pressure (6 points).');
    expect(parseCombatTaskName(data.taskName)).toEqual({ name: 'No Pressure', points: 6 });
  });

  it('handles the singular "(1 point)"', () => {
    expect(parseCombatTaskName(' Noxious Foe (1 point).')).toEqual({
      name: 'Noxious Foe',
      points: 1,
    });
  });

  it('accepts a missing period, odd spacing and any case', () => {
    expect(parseCombatTaskName('Task (2 points)')).toEqual({ name: 'Task', points: 2 });
    expect(parseCombatTaskName('  Task   ( 3  POINTS )  .  ')).toEqual({ name: 'Task', points: 3 });
    expect(parseCombatTaskName('Task(4 Points).')).toEqual({ name: 'Task', points: 4 });
  });

  it('keeps parentheses that belong to the name', () => {
    expect(parseCombatTaskName(' Perfect Olm (Solo) (5 points).')).toEqual({
      name: 'Perfect Olm (Solo)',
      points: 5,
    });
    expect(parseCombatTaskName(' Odd (3 points) name (2 points).')).toEqual({
      name: 'Odd (3 points) name',
      points: 2,
    });
  });

  it('keeps a period that ends the name itself', () => {
    expect(parseCombatTaskName('Done. (2 points).')).toEqual({ name: 'Done.', points: 2 });
  });

  it('returns the trimmed text without a trailing period and points null when there is no suffix', () => {
    expect(parseCombatTaskName(' No Pressure.')).toEqual({ name: 'No Pressure', points: null });
    expect(parseCombatTaskName('No Pressure')).toEqual({ name: 'No Pressure', points: null });
    expect(parseCombatTaskName('Task (six points).')).toEqual({
      name: 'Task (six points)',
      points: null,
    });
    expect(parseCombatTaskName('Task (6 points) extra.')).toEqual({
      name: 'Task (6 points) extra',
      points: null,
    });
    expect(parseCombatTaskName('Task (-1 points).')).toEqual({
      name: 'Task (-1 points)',
      points: null,
    });
  });

  it('handles empty and suffix-only text', () => {
    expect(parseCombatTaskName('')).toEqual({ name: '', points: null });
    expect(parseCombatTaskName('   ')).toEqual({ name: '', points: null });
    expect(parseCombatTaskName('.')).toEqual({ name: '', points: null });
    expect(parseCombatTaskName(' (6 points).')).toEqual({ name: '', points: 6 });
  });

  it('gives an empty name for non-strings', () => {
    for (const v of [undefined, null, 6, {}, ['No Pressure (6 points).']]) {
      expect(parseCombatTaskName(v)).toEqual({ name: '', points: null });
    }
  });

  it('splits off a points number too large to be exact, with points null', () => {
    expect(parseCombatTaskName('Task (99999999999999999999 points).')).toEqual({
      name: 'Task',
      points: null,
    });
    expect(parseCombatTaskName('Task (123456 points).')).toEqual({ name: 'Task', points: 123_456 });
  });

  it('stays fast on hostile input (no quadratic backtracking)', () => {
    const hostile = `a${' '.repeat(200_000)}(${'1'.repeat(1000)} ${'('.repeat(100_000)}`;
    const started = performance.now();
    expect(parseCombatTaskName(hostile).points).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
