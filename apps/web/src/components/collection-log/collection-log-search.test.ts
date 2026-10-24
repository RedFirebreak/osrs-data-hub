import { describe, expect, it } from 'vitest';
import { filterGroups } from './collection-log-search';

const slot = (item: string) => ({
  itemId: 1,
  item,
  killCount: null,
  value: null,
  at: '2026-10-20T00:00:00.000Z',
  source: null,
});
const groups = [
  { source: 'Zulrah', slots: [slot('Tanzanite fang'), slot('Magic fang'), slot('Jar of swamp')] },
  { source: 'Vorkath', slots: [slot('Jar of decay')] },
  { source: null, slots: [slot('Pet snakeling')] },
];

describe('filterGroups', () => {
  it('keeps everything for a blank query', () => {
    expect(filterGroups(groups, '  ')).toEqual(groups);
  });

  it('keeps a whole source that matches', () => {
    expect(filterGroups(groups, 'zul')).toEqual([groups[0]]);
  });

  it('keeps only the matching items otherwise, case-insensitive', () => {
    expect(filterGroups(groups, 'JAR').map((g) => [g.source, g.slots.map((s) => s.item)])).toEqual([
      ['Zulrah', ['Jar of swamp']],
      ['Vorkath', ['Jar of decay']],
    ]);
  });

  it('finds the slots without a drop by that name too', () => {
    expect(filterGroups(groups, 'without')).toEqual([groups[2]]);
  });
});
