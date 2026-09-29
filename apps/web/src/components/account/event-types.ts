/**
 * The event type filter's choices: every known stored type (loot, level_up, …) labelled with
 * describeEvent's title ("Loot", "Level up", …), in @hub/core's order. Server-side (it runs
 * describeEvent); the result is passed to the client timeline as plain data.
 */
import { KNOWN_EVENT_TYPES, describeEvent } from '@hub/core';

export interface EventTypeOption {
  value: string;
  label: string;
}

export function eventTypeOptions(): EventTypeOption[] {
  return KNOWN_EVENT_TYPES.map((type) => ({
    value: type,
    label: describeEvent('', {
      type,
      valueGp: null,
      skill: null,
      level: null,
      tier: null,
      points: null,
      data: null,
    }).title,
  }));
}
