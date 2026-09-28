/** Plugin event type → stored `events.type` (lower_snake). Unknown types are stored as sent. */
export const EVENT_TYPE_MAP = {
  loot: 'loot',
  pkLoot: 'pk_loot',
  death: 'death',
  levelUp: 'level_up',
  collectionLog: 'collection_log',
  superiorSpawn: 'superior_spawn',
  achievementDiary: 'achievement_diary',
  combatTask: 'combat_task',
} as const;

export type KnownEventType = (typeof EVENT_TYPE_MAP)[keyof typeof EVENT_TYPE_MAP];

export const KNOWN_EVENT_TYPES: readonly KnownEventType[] = Object.values(EVENT_TYPE_MAP);

/** One row for the `events` table (without account/device/received_at, which the caller adds). */
export interface NormalizedEvent {
  pluginEventId: string;
  /** Index within a levelUp array (its original position); 0 for every other type. */
  subIndex: number;
  type: string;
  occurredAt: Date;
  valueGp: number | null;
  itemId: number | null;
  npcId: number | null;
  skill: string | null;
  level: number | null;
  tier: string | null;
  points: number | null;
  /** The original event object, with NUL characters removed (jsonb rejects \u0000). */
  data: unknown;
}

export type ShutdownReason = 'logout' | 'shutdown' | 'disabled';

export interface NormalizeResult {
  events: NormalizedEvent[];
  /** The last clientShutdown in the payload, if any (it ends the session instead of being stored). */
  shutdown: { reason: ShutdownReason; occurredAt: Date } | null;
  /** Events (or levelUp elements) dropped as malformed. */
  skipped: number;
}
