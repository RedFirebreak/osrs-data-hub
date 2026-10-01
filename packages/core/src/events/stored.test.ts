import { describe, expect, it } from 'vitest';
import { highestValueItem, storedEventData } from './stored';

describe('stored event readers', () => {
  const top = { id: 995, name: 'Coins', quantity: 250 };
  const stored = { type: 'loot', eventId: 'e1', data: { highestValueItem: top, totalValue: 250 } };

  it('reads the plugin data of a stored event', () => {
    expect(storedEventData(stored)).toBe(stored.data);
    expect(highestValueItem(stored)).toBe(top);
  });

  it('gives an empty object for anything that is not there', () => {
    for (const odd of [null, undefined, 'loot', 5, [], [stored], {}, { data: null }]) {
      expect(storedEventData(odd)).toEqual({});
      expect(highestValueItem(odd)).toEqual({});
    }
    // A level_up row stores the whole levelUp array as its data.
    expect(storedEventData({ data: [{ skill: 'Attack', level: 2 }] })).toEqual({});
    expect(highestValueItem({ data: { highestValueItem: 'x' } })).toEqual({});
    expect(highestValueItem({ data: { highestValueItem: [top] } })).toEqual({});
    // The inner data passed by mistake is not an event.
    expect(highestValueItem(stored.data)).toEqual({});
  });
});
