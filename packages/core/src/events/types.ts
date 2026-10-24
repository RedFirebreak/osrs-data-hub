/**
 * The lucide-react icon hints an event description carries (apps/web's event-icon.tsx gives each its
 * icon and tint). 'bell' is the hint of a type the hub doesn't know.
 */
export type EventIconHint =
  'gift' | 'skull' | 'trending-up' | 'book' | 'swords' | 'map' | 'sparkles' | 'bell';

export const UNKNOWN_EVENT_ICON: EventIconHint = 'bell';

export interface EventTypeInfo {
  /** The plugin's name for the type, as sent in `events[].type` (camelCase). */
  plugin: string;
  /** Short title, e.g. "Loot", "Level up": describeEvent's title and the type filters' label. */
  title: string;
  icon: EventIconHint;
  /** Set when the type carries a loot value (minimum loot values apply to these). */
  loot?: true;
}

const TYPES = {
  loot: { plugin: 'loot', title: 'Loot', icon: 'gift', loot: true },
  pk_loot: { plugin: 'pkLoot', title: 'Loot chest', icon: 'gift', loot: true },
  death: { plugin: 'death', title: 'Death', icon: 'skull' },
  level_up: { plugin: 'levelUp', title: 'Level up', icon: 'trending-up' },
  collection_log: { plugin: 'collectionLog', title: 'Collection log', icon: 'book' },
  superior_spawn: { plugin: 'superiorSpawn', title: 'Superior spawn', icon: 'sparkles' },
  achievement_diary: { plugin: 'achievementDiary', title: 'Achievement diary', icon: 'map' },
  combat_task: { plugin: 'combatTask', title: 'Combat task', icon: 'swords' },
} satisfies Record<string, EventTypeInfo>;

/** A stored `events.type` (lower_snake) the hub knows. */
export type KnownEventType = keyof typeof TYPES;

/**
 * Every event type the hub knows, by stored name, in the order the type filters list them. The one
 * place a type's names, title and icon hint are written down; what a type's line says is describe.ts,
 * and which columns it fills is normalize.ts. Unknown plugin types are stored as sent and have no
 * entry.
 */
export const EVENT_TYPES: Readonly<Record<KnownEventType, EventTypeInfo>> = TYPES;

export const KNOWN_EVENT_TYPES = Object.keys(TYPES) as readonly KnownEventType[];

/** Stored event types that carry a loot value (minimum loot values apply to these). */
export const LOOT_EVENT_TYPES: readonly KnownEventType[] = KNOWN_EVENT_TYPES.filter(
  (type) => EVENT_TYPES[type].loot === true,
);

const BY_PLUGIN: ReadonlyMap<string, KnownEventType> = new Map(
  KNOWN_EVENT_TYPES.map((type) => [EVENT_TYPES[type].plugin, type]),
);
const LOOT_TYPES: ReadonlySet<string> = new Set(LOOT_EVENT_TYPES);

/** Whether `type` is a stored type name the hub knows ('level_up', not the plugin's 'levelUp'). */
export function isKnownEventType(type: string): type is KnownEventType {
  return Object.hasOwn(EVENT_TYPES, type);
}

/**
 * The stored type of a plugin type name the hub knows ('levelUp' → 'level_up'); undefined for any
 * other name, including a stored name the plugin doesn't use ('level_up').
 */
export function knownPluginEventType(pluginName: string): KnownEventType | undefined {
  return BY_PLUGIN.get(pluginName);
}

/** Plugin type name → stored `events.type`; any other name (an unknown type) is returned as is. */
export function storedEventType(pluginName: string): string {
  return BY_PLUGIN.get(pluginName) ?? pluginName;
}

/** Whether a stored type carries a loot value ('loot', 'pk_loot'). */
export function isLootEvent(type: string): boolean {
  return LOOT_TYPES.has(type);
}

/** A stored type's title ('level_up' → "Level up"); a type the hub doesn't know is its own title. */
export function eventTypeTitle(type: string): string {
  return isKnownEventType(type) ? EVENT_TYPES[type].title : type;
}

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
