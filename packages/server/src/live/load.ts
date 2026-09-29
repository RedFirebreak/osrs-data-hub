/**
 * The reads behind one live notification. Each helper is a single query; the hub runs them once per
 * notification and shares the result across every subscriber.
 */
import type { Viewer } from '@hub/core';
import { devices, events, latestState, osrsAccounts, users, type DbOrTx } from '@hub/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { EventRowLike } from '../feed';

/** The account fields every live message shows. */
export interface LiveAccount {
  id: number;
  publicId: string;
  name: string;
  accountType: number | null;
}

/** The `events` columns a FeedEvent is built from (plus the account, for multi-account reads). */
export const EVENT_ROW_COLUMNS = {
  id: events.id,
  seq: events.seq,
  accountId: events.accountId,
  type: events.type,
  occurredAt: events.occurredAt,
  receivedAt: events.receivedAt,
  valueGp: events.valueGp,
  itemId: events.itemId,
  npcId: events.npcId,
  skill: events.skill,
  level: events.level,
  tier: events.tier,
  points: events.points,
  specialWorld: events.specialWorld,
  data: events.data,
};

/**
 * The events of one account with these seqs, ascending by seq. The account filter is defensive: a
 * notification names one account, and a seq of another account must not be shown under its name.
 */
export async function loadEventRows(
  db: DbOrTx,
  accountId: number,
  seqs: readonly number[],
): Promise<EventRowLike[]> {
  if (seqs.length === 0) return [];
  return db
    .select(EVENT_ROW_COLUMNS)
    .from(events)
    .where(and(eq(events.accountId, accountId), inArray(events.seq, [...new Set(seqs)])))
    .orderBy(asc(events.seq));
}

export async function loadLiveAccount(db: DbOrTx, accountId: number): Promise<LiveAccount | null> {
  const [row] = await db
    .select({
      id: osrsAccounts.id,
      publicId: osrsAccounts.publicId,
      name: osrsAccounts.currentName,
      accountType: osrsAccounts.accountType,
    })
    .from(osrsAccounts)
    .where(eq(osrsAccounts.id, accountId));
  return row ?? null;
}

/** An account with the presence columns of its latest_state (null columns when it has no row yet). */
export interface PresenceRow extends LiveAccount {
  /** latest_state.last_seen, else the account's own last_seen. */
  lastSeen: Date;
  gameState: string | null;
  tickDelay: number | null;
  world: number | null;
  specialWorld: boolean;
}

export async function loadPresence(db: DbOrTx, accountId: number): Promise<PresenceRow | null> {
  const [row] = await db
    .select({
      id: osrsAccounts.id,
      publicId: osrsAccounts.publicId,
      name: osrsAccounts.currentName,
      accountType: osrsAccounts.accountType,
      accountLastSeen: osrsAccounts.lastSeen,
      stateLastSeen: latestState.lastSeen,
      gameState: latestState.gameState,
      tickDelay: latestState.tickDelay,
      world: latestState.world,
      specialWorld: latestState.specialWorld,
    })
    .from(osrsAccounts)
    .leftJoin(latestState, eq(latestState.accountId, osrsAccounts.id))
    .where(eq(osrsAccounts.id, accountId));
  if (!row) return null;
  const { accountLastSeen, stateLastSeen, ...rest } = row;
  return { ...rest, lastSeen: stateLastSeen ?? accountLastSeen, specialWorld: !!row.specialWorld };
}

/** Who owns a device, and that user's standing on one account (the wizard's step 3). */
export interface DeviceAccountRow {
  deviceUserId: string;
  ownerUserId: string | null;
  ownerName: string | null;
}

const ownerUsers = alias(users, 'live_owner_users');

export async function loadDeviceAccount(
  db: DbOrTx,
  deviceId: string,
  accountId: number,
): Promise<DeviceAccountRow | null> {
  const [row] = await db
    .select({
      deviceUserId: devices.userId,
      ownerUserId: osrsAccounts.ownerUserId,
      ownerName: ownerUsers.name,
    })
    .from(devices)
    .innerJoin(osrsAccounts, eq(osrsAccounts.id, accountId))
    .leftJoin(ownerUsers, eq(ownerUsers.id, osrsAccounts.ownerUserId))
    .where(eq(devices.id, deviceId));
  return row ?? null;
}

/**
 * The current status and admin flag of these users (absent from the map when deleted). The hub
 * re-reads its subscribers with it, because a stream outlives changes to its user (offboarding,
 * admin changes).
 */
export async function loadViewers(
  db: DbOrTx,
  userIds: readonly string[],
): Promise<Map<string, Viewer>> {
  const out = new Map<string, Viewer>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return out;
  const rows = await db
    .select({ userId: users.id, status: users.status, isAdmin: users.isAdmin })
    .from(users)
    .where(inArray(users.id, ids));
  for (const row of rows) out.set(row.userId, row);
  return out;
}
