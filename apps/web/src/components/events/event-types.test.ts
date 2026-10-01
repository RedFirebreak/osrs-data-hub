import { describe, expect, it } from 'vitest';
import { eventTypeOptions } from './event-types';

describe('eventTypeOptions', () => {
  it('lists every known type with its title, in core order', () => {
    expect(eventTypeOptions()).toEqual([
      { value: 'loot', label: 'Loot' },
      { value: 'pk_loot', label: 'Loot chest' },
      { value: 'death', label: 'Death' },
      { value: 'level_up', label: 'Level up' },
      { value: 'collection_log', label: 'Collection log' },
      { value: 'superior_spawn', label: 'Superior spawn' },
      { value: 'achievement_diary', label: 'Achievement diary' },
      { value: 'combat_task', label: 'Combat task' },
    ]);
  });
});
