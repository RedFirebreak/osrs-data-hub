import type { ItemData, Location, ParsedPayload } from '../payload/types';

/** The parts of the previous `latest_state` row that snapshot planning needs. */
export interface PrevState {
  sourceDeviceId: string | null;
  sourceTs: Date | null;
  skills: Record<string, { xp: number; level: number }> | null;
  equipment: ItemData[] | null;
  gameState: string | null;
  world: number | null;
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
  location?: Location;
  locationUpdatedAt?: Date;
  skills?: Record<string, { xp: number; level: number }>;
  skillsUpdatedAt?: Date;
  inventory?: ItemData[];
  inventoryUpdatedAt?: Date;
  equipment?: ItemData[];
  equipmentUpdatedAt?: Date;
}

/** Everything a snapshot (the `player` part of a payload) should write, decided purely. */
export interface SnapshotPlan {
  /** Same device, older payload time than the last applied snapshot: skip derived writes + latest. */
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
  /** Location sample for the 1-minute bucket. */
  locationSample: {
    ts: Date;
    x: number;
    y: number;
    plane: number;
    onBoat: boolean;
    world: number | null;
  } | null;
  /** Carried wealth when both inventory and equipment are present (UTC day of recv). */
  wealth: { day: string; value: number } | null;
  /** Session bookkeeping for this payload. */
  session: { open: boolean; extend: boolean; world: number | null };
  /** latest_state columns to write; null when the snapshot is stale. */
  latestPatch: LatestStatePatch | null;
}

export type { ParsedPayload };
