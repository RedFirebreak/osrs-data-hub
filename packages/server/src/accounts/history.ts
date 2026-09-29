/**
 * Milestone 2 histories of one account: play sessions (activity), the equipment change log
 * (equipment), carried wealth per day (inventory) and the location trail (location_history). Each
 * returns null when the account isn't visible or the viewer lacks the category, so routes answer 404.
 */
import { utcDay, type Category, type ItemData, type Viewer } from '@hub/core';
import {
  equipmentChanges,
  locationSamples,
  playSessions,
  wealthDaily,
  type DbOrTx,
  type SessionEndReason,
} from '@hub/db';
import { and, asc, desc, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { loadVisibleAccount } from './load';
import { assertValidDate } from './xp';

/** Most rows a history returns (the newest ones win). */
export const MAX_SESSIONS = 1000;
export const MAX_EQUIPMENT_CHANGES = 500;
/** 31 days of 1-minute samples: the whole 30-day trail fits. */
export const MAX_LOCATION_SAMPLES = 31 * 24 * 60;

export interface HistoryRange {
  from: Date;
  to: Date;
}

export interface PlaySession {
  id: string;
  startedAt: string;
  /** null while the session is open. */
  endedAt: string | null;
  /** The last in-game payload of the session. */
  lastSeenAt: string;
  /** (endedAt ?? lastSeenAt) − startedAt; an open session counts up to its last payload. */
  durationMs: number;
  worlds: number[];
  endReason: SessionEndReason | null;
}

export interface EquipmentChange {
  changedAt: string;
  items: ItemData[];
}

export interface WealthDay {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  lastValue: number;
  maxValue: number;
}

export interface LocationPoint {
  ts: string;
  x: number;
  y: number;
  plane: number;
  world: number | null;
  onBoat: boolean;
}

/**
 * Play sessions overlapping [from, to], newest first (at most MAX_SESSIONS). Sessions from special
 * worlds are included (D-45); the world list says where it happened. Gated by `activity`.
 */
export async function getSessions(
  db: DbOrTx,
  viewer: Viewer,
  publicId: string,
  range: HistoryRange,
): Promise<PlaySession[] | null> {
  const accountId = await gate(db, viewer, publicId, 'activity', range);
  if (accountId === null) return null;
  const rows = await db
    .select({
      id: playSessions.id,
      startedAt: playSessions.startedAt,
      endedAt: playSessions.endedAt,
      lastSeenAt: playSessions.lastSeenAt,
      worlds: playSessions.worlds,
      endReason: playSessions.endReason,
    })
    .from(playSessions)
    .where(
      and(
        eq(playSessions.accountId, accountId),
        lte(playSessions.startedAt, range.to),
        // Ended sessions by their end; an open one by its last payload.
        or(
          gte(playSessions.endedAt, range.from),
          and(isNull(playSessions.endedAt), gte(playSessions.lastSeenAt, range.from)),
        ),
      ),
    )
    .orderBy(desc(playSessions.startedAt))
    .limit(MAX_SESSIONS);
  return rows.map((r) => {
    const end = r.endedAt ?? r.lastSeenAt;
    return {
      id: r.id,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt?.toISOString() ?? null,
      lastSeenAt: r.lastSeenAt.toISOString(),
      durationMs: Math.max(0, end.getTime() - r.startedAt.getTime()),
      worlds: r.worlds,
      endReason: r.endReason,
    };
  });
}

/**
 * Equipment changes (a row per change of the slot → item map) in [from, to], newest first (at most
 * MAX_EQUIPMENT_CHANGES). Gated by `equipment`.
 */
export async function getEquipmentHistory(
  db: DbOrTx,
  viewer: Viewer,
  publicId: string,
  range: HistoryRange,
): Promise<EquipmentChange[] | null> {
  const accountId = await gate(db, viewer, publicId, 'equipment', range);
  if (accountId === null) return null;
  const rows = await db
    .select({ changedAt: equipmentChanges.changedAt, equipment: equipmentChanges.equipment })
    .from(equipmentChanges)
    .where(
      and(
        eq(equipmentChanges.accountId, accountId),
        gte(equipmentChanges.changedAt, range.from),
        lte(equipmentChanges.changedAt, range.to),
      ),
    )
    .orderBy(desc(equipmentChanges.changedAt))
    .limit(MAX_EQUIPMENT_CHANGES);
  return rows.map((r) => ({
    changedAt: r.changedAt.toISOString(),
    items: Array.isArray(r.equipment) ? (r.equipment as ItemData[]) : [],
  }));
}

/**
 * Carried wealth (inventory + equipment, GE value) per UTC day for the days from `from` to `to`,
 * oldest first. Gated by `inventory` (handoff §10: "current inventory and wealth history").
 */
export async function getWealthHistory(
  db: DbOrTx,
  viewer: Viewer,
  publicId: string,
  range: HistoryRange,
): Promise<WealthDay[] | null> {
  const accountId = await gate(db, viewer, publicId, 'inventory', range);
  if (accountId === null) return null;
  return db
    .select({
      day: wealthDaily.day,
      lastValue: wealthDaily.lastValue,
      maxValue: wealthDaily.maxValue,
    })
    .from(wealthDaily)
    .where(
      and(
        eq(wealthDaily.accountId, accountId),
        gte(wealthDaily.day, utcDay(range.from)),
        lte(wealthDaily.day, utcDay(range.to)),
      ),
    )
    .orderBy(asc(wealthDaily.day));
}

/**
 * The location trail (at most one sample per minute, kept LOCATION_RETENTION_DAYS) in [from, to],
 * oldest first; when there are more than MAX_LOCATION_SAMPLES the newest ones are returned. Gated by
 * `location_history`. Snapshot coordinates only: event locations are another coordinate space
 * (PLUGIN-12) and are never mixed in.
 */
export async function getLocationHistory(
  db: DbOrTx,
  viewer: Viewer,
  publicId: string,
  range: HistoryRange,
): Promise<LocationPoint[] | null> {
  const accountId = await gate(db, viewer, publicId, 'location_history', range);
  if (accountId === null) return null;
  const rows = await db
    .select({
      ts: locationSamples.ts,
      x: locationSamples.x,
      y: locationSamples.y,
      plane: locationSamples.plane,
      world: locationSamples.world,
      onBoat: locationSamples.onBoat,
    })
    .from(locationSamples)
    .where(
      and(
        eq(locationSamples.accountId, accountId),
        gte(locationSamples.ts, range.from),
        lte(locationSamples.ts, range.to),
      ),
    )
    .orderBy(desc(locationSamples.ts))
    .limit(MAX_LOCATION_SAMPLES);
  return rows.reverse().map((r) => ({ ...r, ts: r.ts.toISOString() }));
}

/** The account id when the viewer may read `category` of the account, else null. */
async function gate(
  db: DbOrTx,
  viewer: Viewer,
  publicId: string,
  category: Category,
  range: HistoryRange,
): Promise<number | null> {
  assertValidDate(range.from, 'from');
  assertValidDate(range.to, 'to');
  const entry = await loadVisibleAccount(db, viewer, publicId);
  return entry && entry.access.categories.has(category) ? entry.account.id : null;
}
