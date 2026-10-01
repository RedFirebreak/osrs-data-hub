/**
 * Pairing codes for the onboarding wizard (handoff §6.2): 5 digits, valid for PAIRING_CODE_TTL_SECONDS,
 * single-use, unique among unconsumed codes (partial unique index `pairing_codes_active_code_uidx`),
 * at most 3 active per user. Expired unconsumed rows keep their code until it is drawn again, when
 * they are deleted to make room.
 */
import { generatePairingCode, isValidPairingCode } from '@hub/core';
import {
  deviceAccounts,
  devices,
  osrsAccounts,
  pairingCodes,
  users,
  type Db,
  type DbOrTx,
  type Tx,
} from '@hub/db';
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { normalizeDeviceLabel } from '../devices/util';
import { isUuid } from '../uuid';

/** Most active (unconsumed, unexpired) codes a user can hold (handoff §6.2.1). */
export const MAX_ACTIVE_PAIRING_CODES = 3;
/** Random draws before giving up; with ≤ a few hundred active codes out of 100k, 10 never all collide. */
const MAX_CODE_ATTEMPTS = 10;

export interface CreatedPairingCode {
  id: string;
  code: string;
  expiresAt: Date;
}

/**
 * Creates a pairing code for the wizard. In one transaction, serialized per user so two concurrent
 * requests can't both see room: the user's oldest active codes are expired (expires_at = now) so
 * that at most MAX_ACTIVE_PAIRING_CODES are active after the insert ("Regenerate" retires the oldest
 * one), then a random code is drawn until one is free (at most 10 tries, then it throws). The label
 * is normalized (trimmed, ≤ 64 characters, empty → null) and becomes the device's label on pairing.
 */
export async function createPairingCode(
  db: Db,
  opts: { userId: string; label?: string | null; ttlSeconds: number; now?: Date },
): Promise<CreatedPairingCode> {
  if (!(Number.isFinite(opts.ttlSeconds) && opts.ttlSeconds > 0)) {
    throw new RangeError(`ttlSeconds must be positive: ${opts.ttlSeconds}`);
  }
  const now = opts.now ?? new Date();
  const values = {
    userId: opts.userId,
    label: normalizeDeviceLabel(opts.label),
    now,
    expiresAt: new Date(now.getTime() + opts.ttlSeconds * 1000),
  };
  return db.transaction(async (tx) => {
    // Transaction-scoped advisory lock per user; the single-bigint key space never overlaps the
    // two-int4 locks ingest takes per account.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pairing_codes:${opts.userId}`}, 0))`,
    );
    await expireOldestActiveCodes(tx, opts.userId, now, MAX_ACTIVE_PAIRING_CODES - 1);
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      const created = await insertCodeWithValue(tx, { ...values, code: generatePairingCode() });
      if (created) return created;
    }
    throw new Error(`no free pairing code after ${MAX_CODE_ATTEMPTS} attempts`);
  });
}

/** Expires the user's active codes beyond the newest `keep`. */
async function expireOldestActiveCodes(
  tx: Tx,
  userId: string,
  now: Date,
  keep: number,
): Promise<void> {
  await tx.execute(sql`
    UPDATE pairing_codes SET expires_at = ${now}
    WHERE id IN (
      SELECT id FROM pairing_codes
      WHERE user_id = ${userId} AND consumed_at IS NULL AND expires_at > ${now}
      ORDER BY created_at DESC, id DESC
      OFFSET ${keep}
    )`);
}

/**
 * One draw of createPairingCode with a given `code` (exported for tests, which can't control the
 * random draw). An expired, unconsumed row holding the code is deleted first: the unique index covers
 * every unconsumed row, expired ones included. The insert then either takes the code or finds it
 * active for someone (`ON CONFLICT … DO NOTHING` on the partial index) and returns null.
 */
export async function insertCodeWithValue(
  tx: DbOrTx,
  v: { code: string; userId: string; label: string | null; now: Date; expiresAt: Date },
): Promise<CreatedPairingCode | null> {
  if (!isValidPairingCode(v.code)) throw new RangeError('pairing code must be 5 ASCII digits');
  await tx
    .delete(pairingCodes)
    .where(
      and(
        eq(pairingCodes.code, v.code),
        isNull(pairingCodes.consumedAt),
        lte(pairingCodes.expiresAt, v.now),
      ),
    );
  const rows = await tx
    .insert(pairingCodes)
    .values({
      code: v.code,
      userId: v.userId,
      label: v.label,
      createdAt: v.now,
      expiresAt: v.expiresAt,
    })
    .onConflictDoNothing({ target: pairingCodes.code, where: sql`consumed_at IS NULL` })
    .returning({ id: pairingCodes.id, code: pairingCodes.code, expiresAt: pairingCodes.expiresAt });
  return rows[0] ?? null;
}

export type PairingCodeStatus = {
  id: string;
  code: string;
  status: 'active' | 'consumed' | 'expired';
  expiresAt: Date;
  /** The device created with this code (null until consumed, or when that device was deleted). */
  deviceId: string | null;
  /** Last pairing attempt with this code from a plugin below MIN_PLUGIN_VERSION. */
  outdatedAttemptAt: Date | null;
  outdatedVersion: string | null;
};

/**
 * The wizard's polling fallback: the state of one of the user's own codes. null when the id isn't a
 * uuid, doesn't exist, or belongs to another user (the route answers 404 for all three). A consumed
 * code is 'consumed' even after it expired.
 */
export async function getPairingCodeStatus(
  db: DbOrTx,
  opts: { userId: string; codeId: string; now?: Date },
): Promise<PairingCodeStatus | null> {
  if (!isUuid(opts.codeId)) return null;
  const now = opts.now ?? new Date();
  const [row] = await db
    .select({
      id: pairingCodes.id,
      code: pairingCodes.code,
      expiresAt: pairingCodes.expiresAt,
      consumedAt: pairingCodes.consumedAt,
      deviceId: pairingCodes.deviceId,
      outdatedAttemptAt: pairingCodes.lastOutdatedAttemptAt,
      outdatedVersion: pairingCodes.lastOutdatedVersion,
    })
    .from(pairingCodes)
    .where(and(eq(pairingCodes.id, opts.codeId), eq(pairingCodes.userId, opts.userId)));
  if (!row) return null;
  const { consumedAt, ...rest } = row;
  const status = consumedAt ? 'consumed' : row.expiresAt > now ? 'active' : 'expired';
  return { ...rest, status };
}

export interface DeviceFirstData {
  account: { publicId: string; name: string; accountType: number | null };
  /** The device owner's role on that account. */
  role: 'owner' | 'contributor';
  /** Display name of the account's owner (the user themself when role is 'owner'); null when none. */
  ownerName: string | null;
}

const ownerUsers = alias(users, 'owner_users');

/**
 * The wizard's step 3 ("Receiving data for Zezima"): the first account the user's own device reported
 * (device_accounts ordered by first_seen), with the user's role on it and the owner's name. null while
 * the device has reported nothing, or when it isn't the user's device.
 */
export async function getDeviceFirstData(
  db: DbOrTx,
  opts: { userId: string; deviceId: string },
): Promise<DeviceFirstData | null> {
  if (!isUuid(opts.deviceId)) return null;
  const [row] = await db
    .select({
      publicId: osrsAccounts.publicId,
      name: osrsAccounts.currentName,
      accountType: osrsAccounts.accountType,
      ownerUserId: osrsAccounts.ownerUserId,
      ownerName: ownerUsers.name,
    })
    .from(deviceAccounts)
    .innerJoin(devices, eq(devices.id, deviceAccounts.deviceId))
    .innerJoin(osrsAccounts, eq(osrsAccounts.id, deviceAccounts.accountId))
    .leftJoin(ownerUsers, eq(ownerUsers.id, osrsAccounts.ownerUserId))
    .where(and(eq(deviceAccounts.deviceId, opts.deviceId), eq(devices.userId, opts.userId)))
    .orderBy(asc(deviceAccounts.firstSeen), asc(deviceAccounts.accountId))
    .limit(1);
  if (!row) return null;
  return {
    account: { publicId: row.publicId, name: row.name, accountType: row.accountType },
    // owner_user_id is the source of truth; account_links.role mirrors it.
    role: row.ownerUserId === opts.userId ? 'owner' : 'contributor',
    ownerName: row.ownerName ?? null,
  };
}
