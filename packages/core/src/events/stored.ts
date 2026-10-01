/**
 * Readers for a stored original event (`events.data`): {type, data, eventId, timestamp}, possibly
 * redacted, so nothing about its shape is taken for granted.
 */
import { isRecord } from '../guards';

/** The plugin's `data` of a stored event when it is an object; {} when missing or anything else. */
export function storedEventData(stored: unknown): Record<string, unknown> {
  const sent = isRecord(stored) ? stored.data : undefined;
  return isRecord(sent) ? sent : {};
}

/**
 * A loot event's most valuable item as the plugin sent it ({id, name, quantity, …}); {} when there is
 * none. Its fields are not validated: callers check the ones they read.
 */
export function highestValueItem(stored: unknown): Record<string, unknown> {
  const top = storedEventData(stored).highestValueItem;
  return isRecord(top) ? top : {};
}
