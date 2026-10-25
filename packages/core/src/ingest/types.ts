import type { ItemData, Location, ParsedPayload } from '../payload/types';

/** The parts of the previous `latest_state` row that snapshot planning needs. */
export interface PrevState {
  sourceDeviceId: string | null;
  sourceTs: Date | null;
  skills: Record<string, { xp: number; level: number }> | null;
  equipment: ItemData[] | null;
  /** The last inventory applied (D-127: a change of it is activity). */
  inventory: ItemData[] | null;
  gameState: string | null;
  world: number | null;
  /** The last location applied, and when the hub received it. */
  location: Location | null;
  locationUpdatedAt: Date | null;
  /** The last bank value applied (D-124), and the plugin time it was read at. */
  bankValue: number | null;
  bankValueAt: Date | null;
}

export interface SnapshotContext {
  /** Server receive time. */
  recv: Date;
  deviceId: string;
  /** min(root.timestamp, recv). */
  payloadTs: Date;
}

export interface XpWrite {
  /** Skill display name, or "Overall" for the derived total. */
  skill: string;
  xp: number;
  /** Plugin level for skills (virtual above 99); real total level (Σ min(level, 99)) for Overall. */
  level: number;
}

/** One row of location_samples (without its account). */
export interface LocationWrite {
  ts: Date;
  x: number;
  y: number;
  plane: number;
  onBoat: boolean;
  world: number | null;
}

/**
 * What a snapshot shows the player doing besides gaining XP (D-127), as bits of `ActivityMark.kinds`:
 * walking or running, a change in the inventory (picking up, dropping, using up or moving an item),
 * a change in what is worn.
 */
export const ACTIVITY_MOVED = 1;
export const ACTIVITY_INVENTORY = 2;
export const ACTIVITY_EQUIPMENT = 4;

/** One row of activity_marks (without its account): something happened in this 5-minute bucket. */
export interface ActivityMark {
  /** The bucket's start (METRICS_BUCKET_MS). */
  bucket: Date;
  /** ACTIVITY_* bits. */
  kinds: number;
}

/** Columns of latest_state to set. Absent keys keep their previous value (D-18). */
export interface LatestStatePatch {
  sourceDeviceId?: string;
  sourceTs?: Date;
  world?: number;
  worldTypes?: string[];
  specialWorld?: boolean;
  worldUpdatedAt?: Date;
  hpCurrent?: number;
  hpMax?: number;
  healthUpdatedAt?: Date;
  prayerCurrent?: number;
  prayerMax?: number;
  prayerUpdatedAt?: Date;
  spellbookId?: number;
  spellbook?: string;
  spellbookUpdatedAt?: Date;
  activePrayers?: string[];
  activePrayersUpdatedAt?: Date;
  location?: Location;
  locationUpdatedAt?: Date;
  skills?: Record<string, { xp: number; level: number }>;
  skillsUpdatedAt?: Date;
  inventory?: ItemData[];
  inventoryUpdatedAt?: Date;
  equipment?: ItemData[];
  equipmentUpdatedAt?: Date;
  bankValue?: number;
  bankValueAt?: Date;
}

/** Everything a snapshot (the `player` part of a payload) should write, decided purely. */
export interface SnapshotPlan {
  /**
   * Same device, older payload time than the last applied snapshot: skip derived writes + latest.
   * Only the trail points of a 1.6 plugin are still written (D-102).
   */
  stale: boolean;
  /** worldTypes intersects the special set: only live fields are updated (D-24 area, handoff §7.1.9). */
  special: boolean;
  /** XP samples to upsert (changed skills + Overall). Empty when nothing changed or skipped. */
  xpWrites: XpWrite[];
  /** An XP drop on a normal world: no XP writes and skills are not applied to latest_state. */
  xpGuardTripped: boolean;
  /** Name of the first skill whose XP dropped (for the log line). */
  xpGuardSkill: string | null;
  /** New equipment list when the slot → itemId map changed (or first seen). */
  equipmentChange: ItemData[] | null;
  /**
   * Rows for location_samples, oldest first, at most one per timestamp: the trail of a 1.6 plugin,
   * or the 1-minute sample of an older one. A stale snapshot still has its trail points.
   */
  locationPoints: LocationWrite[];
  /**
   * The 5-minute buckets in which the player moved, changed the inventory or changed gear (D-127), one
   * entry per bucket, oldest first. Movement comes from the trail's own times (or recv), the rest at
   * recv. A stale snapshot still has the movement of its trail points.
   */
  activity: ActivityMark[];
  /**
   * Wealth when both inventory and equipment are present (UTC day of recv): carried value plus the
   * last known bank value (D-124). `bank` is that bank value, null while none is known.
   */
  wealth: { day: string; value: number; bank: number | null } | null;
  /** Session bookkeeping for this payload. */
  session: { open: boolean; extend: boolean; world: number | null };
  /** latest_state columns to write; null when the snapshot is stale. */
  latestPatch: LatestStatePatch | null;
}

export type { ParsedPayload };
