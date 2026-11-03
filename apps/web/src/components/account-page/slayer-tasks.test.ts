import { describe, expect, it } from 'vitest';
import { doneSlayerTask, slayerTasksSince, slayerTaskTotals } from './slayer-tasks';

const event = (at: string, data: unknown, points: number | null = 15) => ({
  id: `e-${at}`,
  occurredAt: at,
  points,
  data,
});

const kraken = {
  type: 'slayerTaskComplete',
  data: {
    task: 'Kraken',
    amount: 120,
    pointsEarned: 15,
    points: 1249,
    streakType: 'normal',
    streak: 100,
  },
};

describe('doneSlayerTask', () => {
  it('reads the task, its size, points and streak from the stored event', () => {
    expect(doneSlayerTask(event('2026-11-03T10:00:00.000Z', kraken))).toEqual({
      id: 'e-2026-11-03T10:00:00.000Z',
      at: '2026-11-03T10:00:00.000Z',
      task: 'Kraken',
      location: null,
      amount: 120,
      points: 15,
      streak: 100,
      streakType: 'normal',
    });
  });

  it("keeps a Konar task's area, and falls back to pointsEarned", () => {
    const konar = { data: { ...kraken.data, task: 'Wyrms', location: 'Karuulm Slayer Dungeon' } };
    const t = doneSlayerTask(event('2026-11-03T10:00:00.000Z', konar, null));
    expect(t.location).toBe('Karuulm Slayer Dungeon');
    expect(t.points).toBe(15);
  });

  it('is all nulls for an event without data', () => {
    const t = doneSlayerTask(event('2026-11-03T10:00:00.000Z', null, null));
    expect(t).toMatchObject({ task: null, amount: null, points: null, streak: null });
  });
});

describe('slayerTasksSince and slayerTaskTotals', () => {
  const events = [
    event('2026-11-03T10:00:00.000Z', kraken),
    event('2026-11-01T10:00:00.000Z', { data: { task: 'Gargoyles', amount: 200 } }, 12),
    event('2026-10-20T10:00:00.000Z', kraken),
  ];

  it('keeps the tasks in the window, newest first', () => {
    const tasks = slayerTasksSince(events, new Date('2026-10-27T10:00:00.000Z'));
    expect(tasks.map((t) => t.task)).toEqual(['Kraken', 'Gargoyles']);
  });

  it('adds up tasks, kills and points', () => {
    const tasks = slayerTasksSince(events, new Date('2026-10-27T10:00:00.000Z'));
    expect(slayerTaskTotals(tasks)).toEqual({ tasks: 2, kills: 320, points: 27 });
    expect(slayerTaskTotals([])).toEqual({ tasks: 0, kills: 0, points: 0 });
  });
});
