import type { HiscoresActivityView } from '@hub/server';
import { describe, expect, it } from 'vitest';
import { activityTileLabel, tileName } from './hiscores-content';

const row = (activity: string, kind: HiscoresActivityView['kind']): HiscoresActivityView => ({
  activity,
  kind,
  score: 1344,
  rank: 4321,
  modeRank: 12,
});

describe('hiscores tiles', () => {
  it('name a clue tier alone, and everything else in full', () => {
    expect(tileName(row('Clue Scrolls (beginner)', 'clue'))).toBe('Beginner');
    expect(tileName(row('Clue Scrolls (all)', 'clue'))).toBe('All');
    expect(tileName(row('Chambers of Xeric: Challenge Mode', 'boss'))).toBe(
      'Chambers of Xeric: Challenge Mode',
    );
  });

  it('carry the score and the ranks in their label', () => {
    expect(activityTileLabel(row('Zulrah', 'boss'), null)).toBe('Zulrah: 1,344, rank 4,321');
    expect(activityTileLabel(row('Zulrah', 'boss'), 'Ironman')).toBe(
      'Zulrah: 1,344, rank 4,321, Ironman rank 12',
    );
    expect(activityTileLabel({ ...row('Obor', 'boss'), rank: null }, null)).toBe('Obor: 1,344');
  });
});
