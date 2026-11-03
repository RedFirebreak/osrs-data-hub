import { describe, expect, it } from 'vitest';
import {
  mainSlayerStreak,
  readSlayerState,
  slayerKillsDone,
  slayerProgress,
  slayerStreakLabel,
  slayerTaskLabel,
  withoutSlayerLocation,
  type SlayerState,
} from './slayer';

const task = { name: 'Abyssal demons', location: null, remaining: 40, amount: 160 };

describe('slayer task progress', () => {
  it('counts the kills done and the share of the task', () => {
    expect(slayerKillsDone(task)).toBe(120);
    expect(slayerProgress(task)).toBe(0.75);
  });

  it('stays within 0 … 1 for odd sizes', () => {
    expect(slayerProgress({ ...task, amount: 0, remaining: 0 })).toBe(0);
    expect(slayerKillsDone({ ...task, amount: 10, remaining: 20 })).toBe(0);
    expect(slayerProgress({ ...task, amount: 10, remaining: 20 })).toBe(0);
  });
});

describe('slayerTaskLabel', () => {
  it('names the task, with a Konar location', () => {
    expect(slayerTaskLabel(task)).toBe('Abyssal demons');
    expect(slayerTaskLabel({ ...task, location: 'Catacombs of Kourend' })).toBe(
      'Abyssal demons in Catacombs of Kourend',
    );
    expect(slayerTaskLabel({ name: null, location: null })).toBe('Unknown task');
  });
});

describe('slayerStreakLabel', () => {
  it('names the three streaks, an unknown one as the regular streak', () => {
    expect(slayerStreakLabel('normal')).toBe('task streak');
    expect(slayerStreakLabel('wilderness')).toBe('Wilderness streak');
    expect(slayerStreakLabel('mortimer')).toBe('Mortimer streak');
    expect(slayerStreakLabel('league')).toBe('task streak');
  });
});

describe('mainSlayerStreak', () => {
  const state = (streaks: SlayerState['streaks']): SlayerState => ({
    task: null,
    points: 0,
    streaks,
  });

  it('is the regular streak while it runs', () => {
    expect(mainSlayerStreak(state({ normal: 4, wilderness: 30, mortimer: null }))).toEqual({
      streak: 'normal',
      value: 4,
    });
  });

  it('is the longest other one when the regular one is 0', () => {
    expect(mainSlayerStreak(state({ normal: 0, wilderness: 30, mortimer: 2 }))).toEqual({
      streak: 'wilderness',
      value: 30,
    });
    expect(mainSlayerStreak(state({ normal: 0, wilderness: 0, mortimer: 0 }))).toEqual({
      streak: 'normal',
      value: 0,
    });
  });

  it('is null when no streak was sent', () => {
    expect(mainSlayerStreak(state({ normal: null, wilderness: null, mortimer: null }))).toBeNull();
  });
});

describe('readSlayerState', () => {
  const stored: SlayerState = {
    task: { name: 'Kraken', location: null, remaining: 3, amount: 120 },
    points: 1249,
    streaks: { normal: 100, wilderness: 12, mortimer: null },
  };

  it('reads back what ingest wrote', () => {
    expect(readSlayerState(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    expect(readSlayerState({ ...stored, task: null })).toEqual({ ...stored, task: null });
  });

  it('is null for anything else, and drops a task without kills left', () => {
    expect(readSlayerState(null)).toBeNull();
    expect(readSlayerState([])).toBeNull();
    expect(readSlayerState({ points: -1 })).toBeNull();
    expect(readSlayerState({ ...stored, task: { ...stored.task, remaining: 0 } })?.task).toBeNull();
    expect(readSlayerState({ points: 2, streaks: 'x' })).toEqual({
      task: null,
      points: 2,
      streaks: { normal: null, wilderness: null, mortimer: null },
    });
  });
});

describe('withoutSlayerLocation', () => {
  it("drops only a Konar task's location", () => {
    const konar: SlayerState = {
      task: { name: 'Wyrms', location: 'Karuulm Slayer Dungeon', remaining: 5, amount: 130 },
      points: 3,
      streaks: { normal: 1, wilderness: 0, mortimer: 0 },
    };
    expect(withoutSlayerLocation(konar).task).toEqual({ ...konar.task, location: null });
    const none = { ...konar, task: null };
    expect(withoutSlayerLocation(none)).toBe(none);
  });
});
