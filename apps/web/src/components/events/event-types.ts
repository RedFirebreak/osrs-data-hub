/**
 * The event type choices of the timeline's filter chips and the toast settings: every known stored
 * type (loot, level_up, …) labelled with its title ("Loot", "Level up", …), in @hub/core's order.
 * Plain data, so a server component can pass it to a client one.
 */
import { KNOWN_EVENT_TYPES, eventTypeTitle } from '@hub/core';

export interface EventTypeOption {
  value: string;
  label: string;
}

export function eventTypeOptions(): EventTypeOption[] {
  return KNOWN_EVENT_TYPES.map((type) => ({ value: type, label: eventTypeTitle(type) }));
}
