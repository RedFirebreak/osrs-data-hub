/**
 * The Devices pages (handoff §6.3, §12): a user's paired RuneLite connections, rename and revoke, and
 * the admin overview. A device is one token; revoking it makes the next ingest answer 401, and the
 * plugin then disables that connection (handoff §3.2), so a revoke is final: re-pairing creates a new
 * device.
 */
import { resolveAccess } from '@hub/core';
import {
  deviceAccounts,
  devices,
  osrsAccounts,
  users,
  type Db,
  type DbOrTx,
  type DeviceRevokeReason,
} from '@hub/db';
import { and, desc, eq, isNull, type SQL } from 'drizzle-orm';
import { loadAccountAccess, loadViewer } from '../accounts/access';
import { audit } from '../audit';
import { isUuid } from '../uuid';
import { normalizeDeviceLabel } from './util';

export type DeviceStatus = 'active' | 'outdated' | 'revoked';

/** An account a device reported, most recently reported first. */
export interface DeviceAccount {
  publicId: string;
  name: string;
  /** When this device last reported the account. */
  lastSeen: Date;
}

export interface DeviceSummary {
  id: string;
  label: string | null;
  pluginVersion: string | null;
  status: DeviceStatus;
  createdAt: Date;
  lastSeenAt: Date | null;
  firstDataAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  accounts: DeviceAccount[];
}

export interface AdminDeviceRow extends DeviceSummary {
  user: { id: string; name: string };
}

const summaryColumns = {
  id: devices.id,
  label: devices.label,
  pluginVersion: devices.pluginVersion,
  outdatedAt: devices.outdatedAt,
  createdAt: devices.createdAt,
  lastSeenAt: devices.lastSeenAt,
  firstDataAt: devices.firstDataAt,
  revokedAt: devices.revokedAt,
  revokedReason: devices.revokedReason,
};

type SummaryRow = {
  id: string;
  label: string | null;
  pluginVersion: string | null;
  outdatedAt: Date | null;
  createdAt: Date;
  lastSeenAt: Date | null;
  firstDataAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
};

/** Revoked wins over outdated: a revoked device can't send anything any more. */
function deviceStatus(row: { revokedAt: Date | null; outdatedAt: Date | null }): DeviceStatus {
  if (row.revokedAt) return 'revoked';
  if (row.outdatedAt) return 'outdated';
  return 'active';
}

function toSummary(row: SummaryRow, accounts: Map<string, DeviceAccount[]>): DeviceSummary {
  const { outdatedAt: _outdatedAt, ...rest } = row;
  return { ...rest, status: deviceStatus(row), accounts: accounts.get(row.id) ?? [] };
}

type ReportedAccount = DeviceAccount & { deviceId: string; accountId: number };

/**
 * The accounts reported by one user's devices (or by every device when `userId` is null), most
 * recently reported first, in one query. Filtered by a join rather than a list of device ids, so the
 * admin page never binds one parameter per device.
 */
async function loadReportedAccounts(db: DbOrTx, userId: string | null): Promise<ReportedAccount[]> {
  return db
    .select({
      deviceId: deviceAccounts.deviceId,
      accountId: deviceAccounts.accountId,
      publicId: osrsAccounts.publicId,
      name: osrsAccounts.currentName,
      lastSeen: deviceAccounts.lastSeen,
    })
    .from(deviceAccounts)
    .innerJoin(devices, eq(devices.id, deviceAccounts.deviceId))
    .innerJoin(osrsAccounts, eq(osrsAccounts.id, deviceAccounts.accountId))
    .where(userId === null ? undefined : eq(devices.userId, userId))
    .orderBy(desc(deviceAccounts.lastSeen), osrsAccounts.publicId);
}

/** The ids among `accountIds` the user may know exist (@hub/core resolveAccess `visible`). */
async function visibleAccountIds(
  db: DbOrTx,
  userId: string,
  accountIds: readonly number[],
): Promise<Set<number>> {
  const visible = new Set<number>();
  if (accountIds.length === 0) return visible;
  // Sequential: db may be a transaction handle (DB-14).
  const viewer = await loadViewer(db, userId);
  if (!viewer) return visible;
  const access = await loadAccountAccess(db, accountIds);
  for (const [id, account] of access) {
    if (resolveAccess(viewer, account).visible) visible.add(id);
  }
  return visible;
}

function byDevice(rows: readonly ReportedAccount[]): Map<string, DeviceAccount[]> {
  const out = new Map<string, DeviceAccount[]>();
  for (const { deviceId, accountId: _accountId, ...account } of rows) {
    const list = out.get(deviceId) ?? [];
    list.push(account);
    out.set(deviceId, list);
  }
  return out;
}

/**
 * The user's devices, newest first, including revoked ones (the page shows their status). A device
 * is `outdated` when its last request carried a version below MIN_PLUGIN_VERSION (ingest sets
 * `outdated_at` and clears it on the next good one) and it isn't revoked.
 *
 * `accounts` lists only the reported accounts the user may still see (the one resolver, D-22): a
 * hidden account, or one whose owner blocked the user and shares nothing with the guild, drops out,
 * although the device once reported it. Otherwise the page would keep showing its current name (and
 * every later rename) to someone the resolver says may not know it exists.
 */
export async function listDevices(db: DbOrTx, userId: string): Promise<DeviceSummary[]> {
  const rows = await db
    .select(summaryColumns)
    .from(devices)
    .where(eq(devices.userId, userId))
    .orderBy(desc(devices.createdAt), desc(devices.id));
  if (rows.length === 0) return [];
  const reported = await loadReportedAccounts(db, userId);
  const visible = await visibleAccountIds(
    db,
    userId,
    reported.map((r) => r.accountId),
  );
  const accounts = byDevice(reported.filter((r) => visible.has(r.accountId)));
  return rows.map((r) => toSummary(r, accounts));
}

/**
 * Every device of every user, newest first, for the admin page (outdated and revoked included, so the
 * page can filter). Lists every reported account, hidden ones included: admins see everything
 * (resolveAccess admin rule); the caller checks that the viewer is an admin.
 */
export async function listAllDevices(db: DbOrTx): Promise<AdminDeviceRow[]> {
  const rows = await db
    .select({ ...summaryColumns, userId: users.id, userName: users.name })
    .from(devices)
    .innerJoin(users, eq(users.id, devices.userId))
    .orderBy(desc(devices.createdAt), desc(devices.id));
  const accounts = rows.length === 0 ? new Map() : byDevice(await loadReportedAccounts(db, null));
  return rows.map(({ userId, userName, ...row }) => ({
    ...toSummary(row, accounts),
    user: { id: userId, name: userName },
  }));
}

/**
 * Renames one of the user's own devices (revoked ones too). The label is normalized like a pairing
 * label (trimmed, ≤ 64 characters, empty → null). False when the device doesn't exist or belongs to
 * someone else, so the route can answer 404 without revealing other users' devices.
 */
export async function renameDevice(
  db: Db,
  opts: { userId: string; deviceId: string; label: string | null },
): Promise<boolean> {
  if (!isUuid(opts.deviceId)) return false;
  const rows = await db
    .update(devices)
    .set({ label: normalizeDeviceLabel(opts.label) })
    .where(and(eq(devices.id, opts.deviceId), eq(devices.userId, opts.userId)))
    .returning({ id: devices.id });
  return rows.length > 0;
}

/**
 * Revokes a device: the actor's own, or any device when `asAdmin` (the caller checks that the actor
 * is an admin). Only sha256(token) is stored, so revoking is setting `revoked_at`: ingest answers the
 * device's next payload with 401 and the plugin disables the connection (handoff §6.3).
 *
 * Idempotent: revoking an already revoked device keeps its original time and reason, writes no second
 * audit entry and still returns true. False when the device doesn't exist or isn't the actor's (and
 * not `asAdmin`). Audit: 'device.revoked' with the reason and the device's owner.
 */
export async function revokeDevice(
  db: Db,
  opts: {
    deviceId: string;
    actorUserId: string;
    asAdmin?: boolean;
    reason: DeviceRevokeReason;
    now?: Date;
  },
): Promise<boolean> {
  if (!isUuid(opts.deviceId)) return false;
  const now = opts.now ?? new Date();
  const scope: SQL | undefined = opts.asAdmin ? undefined : eq(devices.userId, opts.actorUserId);
  return db.transaction(async (tx) => {
    const revoked = await tx
      .update(devices)
      .set({ revokedAt: now, revokedReason: opts.reason })
      .where(and(eq(devices.id, opts.deviceId), isNull(devices.revokedAt), scope))
      .returning({ id: devices.id, userId: devices.userId });
    const row = revoked[0];
    if (row) {
      await audit(tx, {
        actorUserId: opts.actorUserId,
        action: 'device.revoked',
        targetType: 'device',
        targetId: row.id,
        meta: { reason: opts.reason, ownerUserId: row.userId, asAdmin: opts.asAdmin === true },
      });
      return true;
    }
    // Nothing updated: either already revoked (idempotent success) or not visible to the actor.
    const existing = await tx
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.id, opts.deviceId), scope));
    return existing.length > 0;
  });
}
