/**
 * Parsed HA Exporter payload (v1.5 and later). Everything the plugin can omit is optional: Gson drops nulls, the
 * player can filter sections, and some sends carry no (or a partial) `player` (PLUGIN-1).
 */

/**
 * One item as sent. Inventory is one entry per occupied slot (not merged) and, from plugin 1.5.1, carries
 * inventorySlot; equipment carries equipmentSlot (PLUGIN-11).
 */
export interface ItemData {
  id: number;
  name?: string;
  /** Per-unit GE price (a Java long). */
  gePrice: number;
  /** Per-unit high-alch value (a Java int). */
  haPrice?: number;
  quantity: number;
  /** EquipmentInventorySlot name (HEAD, CAPE, …) on equipment items only. */
  equipmentSlot?: string;
  /**
   * Inventory slot 0..27 (left to right, then top to bottom) on `player.inventory` items from plugin
   * 1.5.1; absent from older plugins and on every other item list (death kept/lost, loot).
   */
  inventorySlot?: number;
  /** Drop probability on some loot items (can be exponent notation on the wire). */
  rarity?: number;
}

export interface Location {
  x: number;
  y: number;
  plane: number;
  isOnBoat?: boolean;
}

/** One tile of `player.locationTrail`: where the player was seen, and when. */
export interface TrailPoint extends Location {
  /** Epoch ms from the player's PC clock. */
  timestamp: number;
}

export interface Meter {
  /** Boosted current value; can exceed max (brews). */
  current: number;
  max: number;
}

export interface SkillValue {
  xp: number;
  /** Virtual above 99 (up to 127 at 200M XP). */
  level: number;
}

/** `player` after section-by-section validation. A section with the wrong shape is left out. */
export interface PlayerSnapshot {
  name?: string;
  /** 56 lowercase hex chars (salted SHA-224). Stable across renames. */
  accountHash?: string;
  /** IRONMAN varbit 0..6, parsed from the string the plugin sends. */
  accountType?: number;
  world?: number;
  /** RuneLite WorldType names; [] on worlds without flags. */
  worldTypes?: string[];
  location?: Location;
  /**
   * Plugin 1.6: every tile visited since the previous message, oldest first, each sent once. [] when
   * the player stood still; absent from older plugins.
   */
  locationTrail?: TrailPoint[];
  health?: Meter;
  prayer?: Meter;
  spellbook?: { id: number; name: string };
  /** stats.skills keyed by skill display name ("Attack", …, "Sailing"). Never contains Overall. */
  skills?: Record<string, SkillValue>;
  inventory?: ItemData[];
  equipment?: ItemData[];
}

/** One event envelope. `raw` is the original JSON object (unknown fields kept), used for storage. */
export interface RawEvent {
  type: string;
  data: unknown;
  eventId: string;
  /** Epoch ms from the player's PC clock; null when missing or not a finite number. */
  timestamp: number | null;
  raw: Record<string, unknown>;
}

export interface ParsedPayload {
  /** null when the payload has no usable `player` object. */
  player: PlayerSnapshot | null;
  events: RawEvent[];
  /** RuneLite GameState name, or null when omitted. */
  state: string | null;
  /** Configured send rate in ticks; 0 = unknown. */
  tickDelay: number;
  /** Root timestamp (epoch ms) or null when missing/invalid. */
  timestamp: number | null;
  /** What was dropped by lenient parsing (for metrics and raw_payloads.meta). */
  skipped: {
    /** e.g. ["player.location", "player.stats"] */
    sections: string[];
    events: number;
    reasons: string[];
  };
}

export type ParseResult =
  { ok: true; payload: ParsedPayload } | { ok: false; error: 'not_json' | 'not_object' };
