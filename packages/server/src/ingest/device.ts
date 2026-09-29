/** Device-level queries that run outside the per-account ingest transaction. */
import { sha256Hex, type ShutdownReason } from '@hub/core';
import { devices, latestState, playSessions, users, type Db } from '@hub/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { notifyState } from '../notify';
import { gameStateAfterShutdown } from './presence';
import { lockAccount, setLocalTimeouts } from './store';

/** An authenticated device (unrevoked, owned by an active user). */
export interface IngestDevice {
  id: string;
  userId: string;
}

/**
 * Looks up `sha256(token)` → device → user. Null (→ 401, D-19) for a missing/empty token, an unknown
 * or revoked device, or a user who isn't active (grace).
 */
export async function authenticateDevice(
  db: Db,
  token: string | null,
): Promise<IngestDevice | null> {
  if (token === null || token === '') return null;
  const [row] = await db
    .select({
      id: devices.id,
      userId: devices.userId,
      revokedAt: devices.revokedAt,
      userStatus: users.status,
    })
    .from(devices)
    .innerJoin(users, eq(users.id, devices.userId))
    .where(eq(devices.tokenHash, sha256Hex(token)));
  if (!row || row.revokedAt !== null || row.userStatus !== 'active') return null;
  return { id: row.id, userId: row.userId };
}

/** Flags the device for the Devices page: it sent a version below the minimum. */
export async function markDeviceOutdated(
  db: Db,
  deviceId: string,
  at: Date,
  pluginVersion: string | null,
): Promise<void> {
  await db.update(devices).set({ outdatedAt: at, pluginVersion }).where(eq(devices.id, deviceId));
}

/**
 * Device presence for payloads that carry no account (D-29): last seen, IP and version, and clears
 * the outdated flag (a good version arrived). first_data_at is left alone: no account yet.
 */
export async function touchDevice(
  db: Db,
  deviceId: string,
  at: Date,
  ip: string | null,
  pluginVersion: string | null,
): Promise<void> {
  await db
    .update(devices)
    .set({ lastSeenAt: at, lastIp: ip, pluginVersion, outdatedAt: null })
    .where(eq(devices.id, deviceId));
}

/**
 * A clientShutdown without identity (client start, "Disabled" on the login screen, PLUGIN-1) closes
 * every open play session of THIS device: ended_at = max(started_at, shutdown time), so a session never
 * ends before it began. Presence of those accounts ends too (gameStateAfterShutdown), but only where
 * the latest state still comes from this device: an account that moved on to another PC keeps its
 * presence. Each affected account gets a hub_state notification (on commit, D-32). Returns the number
 * of sessions closed.
 *
 * Locking: the per-account advisory locks come first, in ascending id order (as offboarding takes
 * them), because an ingest transaction of the same account locks latest_state before play_sessions:
 * touching those rows in the other order without the account lock deadlocks. The ingest
 * transaction's lock/statement timeouts apply (PLUGIN-4).
 */
export async function closeDeviceSessions(
  db: Db,
  deviceId: string,
  shutdown: { reason: ShutdownReason; occurredAt: Date },
  state: string | null,
): Promise<number> {
  return db.transaction(async (tx) => {
    await setLocalTimeouts(tx);
    const open = await tx
      .select({ accountId: playSessions.accountId })
      .from(playSessions)
      .where(and(eq(playSessions.deviceId, deviceId), isNull(playSessions.endedAt)));
    const accountIds = [...new Set(open.map((o) => o.accountId))].sort((a, b) => a - b);
    if (accountIds.length === 0) return 0;
    for (const accountId of accountIds) await lockAccount(tx, accountId);

    const closed = await tx
      .update(playSessions)
      .set({
        endedAt: sql`GREATEST(${playSessions.startedAt}, ${shutdown.occurredAt.toISOString()}::timestamptz)`,
        endReason: shutdown.reason,
      })
      .where(
        and(
          eq(playSessions.deviceId, deviceId),
          isNull(playSessions.endedAt),
          inArray(playSessions.accountId, accountIds),
        ),
      )
      .returning({ accountId: playSessions.accountId });
    const closedIds = closed.map((c) => c.accountId);
    if (closedIds.length > 0) {
      await tx
        .update(latestState)
        .set({ gameState: gameStateAfterShutdown(state) })
        .where(
          and(inArray(latestState.accountId, closedIds), eq(latestState.lastDeviceId, deviceId)),
        );
    }
    for (const accountId of closedIds) {
      await notifyState(tx, { accountId, deviceId });
    }
    return closed.length;
  });
}
