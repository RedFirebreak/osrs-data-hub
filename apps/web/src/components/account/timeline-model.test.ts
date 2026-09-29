import { describe, expect, it } from 'vitest';
import { feedEvent } from '@/components/live/test-fixtures';
import { feedUrl, matchesFilter, mergeEvents, oldestSeq } from './timeline-model';

describe('matchesFilter', () => {
  const loot = feedEvent({ type: 'loot' });
  it('filters by account and by type (no types = all)', () => {
    expect(matchesFilter(loot, { types: [] })).toBe(true);
    expect(matchesFilter(loot, { accountPublicId: 'AbCdEf123456', types: ['loot'] })).toBe(true);
    expect(matchesFilter(loot, { accountPublicId: 'Other0000000', types: [] })).toBe(false);
    expect(matchesFilter(loot, { types: ['death'] })).toBe(false);
  });

  it("drops live events the guild feed's admin filter leaves out (D-81)", () => {
    const guildFilter = { minLootValue: 10_000, showVirtualLevels: false };
    const cheap = feedEvent({ type: 'loot', valueGp: 9_999 });
    const rich = feedEvent({ type: 'loot', valueGp: 10_000 });
    const virtual = feedEvent({ type: 'level_up', skill: 'Magic', level: 110 });
    const combat = feedEvent({ type: 'level_up', skill: 'Combat', level: 110 });
    expect(matchesFilter(cheap, { types: [], guildFilter })).toBe(false);
    expect(matchesFilter(rich, { types: [], guildFilter })).toBe(true);
    expect(matchesFilter(virtual, { types: [], guildFilter })).toBe(false);
    expect(matchesFilter(combat, { types: [], guildFilter })).toBe(true);
    expect(matchesFilter(cheap, { types: [] })).toBe(true);
    expect(matchesFilter(virtual, { types: [] })).toBe(true);
  });
});

describe('mergeEvents', () => {
  it('adds new events once, newest first by seq, and keeps the list when nothing is new', () => {
    const a = feedEvent({ id: 'a', seq: 10 });
    const b = feedEvent({ id: 'b', seq: 12 });
    const c = feedEvent({ id: 'c', seq: 5 });
    const current = [a];
    expect(mergeEvents(current, [a])).toBe(current);
    expect(mergeEvents(current, [c, b, b]).map((e) => e.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('feedUrl and oldestSeq', () => {
  it('builds the feed request for a page', () => {
    expect(feedUrl({ accountPublicId: 'Abc', types: ['loot', 'death'] }, { limit: 20 })).toBe(
      '/api/app/feed?account=Abc&types=loot%2Cdeath&limit=20',
    );
    expect(feedUrl({ types: [] }, { before: 99, limit: 50 })).toBe(
      '/api/app/feed?before=99&limit=50',
    );
  });

  it('continues from the smallest seq shown', () => {
    expect(oldestSeq([feedEvent({ seq: 9 }), feedEvent({ seq: 3 }), feedEvent({ seq: 7 })])).toBe(
      3,
    );
    expect(oldestSeq([])).toBeUndefined();
  });
});
