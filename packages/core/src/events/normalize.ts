import { notImplemented } from '../todo';
import type { RawEvent } from '../payload/types';
import type { NormalizeResult } from './types';

/**
 * Normalizes plugin events into `events` rows (handoff §7.5):
 * - type: EVENT_TYPE_MAP for known types; unknown types kept as sent.
 * - occurredAt: clampEventTime(event.timestamp, recv).
 * - clientShutdown: not a row; data "Logout" | "Shutdown" | "Disabled" → shutdown reason
 *   logout | shutdown | disabled (anything else → 'shutdown'). The LAST one wins.
 * - levelUp: data must be an array; each element {skill: string, level: int} becomes a row with
 *   subIndex = its index in the original array (stable across resends). Invalid elements are skipped
 *   and counted; a non-array levelUp is skipped as one event. skill "Combat" is kept.
 * - loot / pkLoot: valueGp = Σ gePrice × quantity over data.items (64-bit via BigInt, clamped to
 *   Number.MAX_SAFE_INTEGER) when items is a valid array, else data.totalValue, else null;
 *   itemId = data.highestValueItem.id; npcId = data.npcId.
 * - death: valueGp = Σ over data.lostItems, else data.valueLost; npcId = data.killerNpcId.
 * - collectionLog: valueGp = data.value; itemId = data.itemId unless -1 (→ null).
 * - superiorSpawn: npcId = data.npcId.
 * - achievementDiary: tier = lowercased trimmed data.tier.
 * - combatTask: tier likewise; points = parseCombatTaskName(data.taskName).points.
 * - data: the original event object (`raw`) with NUL (U+0000) removed from all strings and keys.
 * Numbers that aren't finite/integers where an int is expected become null (never throw).
 */
export function normalizeEvents(events: readonly RawEvent[], recv: Date): NormalizeResult {
  return notImplemented('normalizeEvents');
}
