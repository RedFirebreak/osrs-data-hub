/**
 * The parts of the data export about the user themself (D-79): profile, settings, devices, API keys,
 * sign-in sessions, the sharing settings they made and the grants given to them, and audit entries
 * about them. Never a token, a token hash or a key secret.
 */
import {
  CATEGORIES,
  effectiveAudience,
  resolveAccess,
  type Category,
  type Viewer,
} from '@hub/core';
import {
  accountShareGrants,
  apiKeys,
  auditLog,
  devices,
  osrsAccounts,
  session,
  users,
  type Db,
} from '@hub/db';
import { and, asc, eq, gt, inArray, or, type SQL } from 'drizzle-orm';
import { loadAccountAccess } from '../accounts/access';
import type { AccountWithAccess } from '../accounts/load';
import { listApiKeys } from '../api/keys';
import { listDevices } from '../devices/devices';
import { getUserSettings } from '../settings/user-settings';
import { keysetPages } from './json';

export type UserRow = NonNullable<Awaited<ReturnType<typeof loadUserRow>>>;

/** The user's row (the columns the export shows), or undefined when it doesn't exist. */
export async function loadUserRow(db: Db, userId: string) {
  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      nickname: users.nickname,
      image: users.image,
      discordId: users.discordId,
      roles: users.roles,
      status: users.status,
      isAdmin: users.isAdmin,
      graceUntil: users.graceUntil,
      offboardReason: users.offboardReason,
      createdAt: users.createdAt,
      lastVerifiedAt: users.lastVerifiedAt,
    })
    .from(users)
    .where(eq(users.id, userId));
  return row;
}

/** `user`: who the export is about, as the hub stores them (the email is a placeholder, AUTH-3). */
export function wireUser(u: UserRow) {
  return {
    id: u.id,
    name: u.name,
    nickname: u.nickname,
    image_url: u.image,
    discord_id: u.discordId,
    roles: u.roles,
    status: u.status,
    is_admin: u.isAdmin,
    grace_until: u.graceUntil?.toISOString() ?? null,
    offboard_reason: u.offboardReason,
    created_at: u.createdAt.toISOString(),
    last_verified_at: u.lastVerifiedAt?.toISOString() ?? null,
  };
}

/** `settings`: the toast filter and time zone (defaults when never saved). */
export async function settingsSection(db: Db, userId: string) {
  const s = await getUserSettings(db, userId);
  return {
    toasts: {
      enabled: s.toast.enabled,
      types: s.toast.types,
      min_loot_value: s.toast.minLootValue,
      own_accounts_only: s.toast.ownAccountsOnly,
    },
    timezone: s.timezone,
  };
}

/**
 * `devices`: the Devices page's list (listDevices: the reported accounts the user may still see) plus
 * the last IP address each one sent from, which the hub stores but no page shows. Never the token
 * hash.
 */
export async function devicesSection(db: Db, userId: string) {
  const list = await listDevices(db, userId);
  const ips = await db
    .select({ id: devices.id, lastIp: devices.lastIp })
    .from(devices)
    .where(eq(devices.userId, userId));
  const ipById = new Map(ips.map((r) => [r.id, r.lastIp]));
  return list.map((d) => ({
    id: d.id,
    label: d.label,
    plugin_version: d.pluginVersion,
    status: d.status,
    created_at: d.createdAt.toISOString(),
    first_data_at: d.firstDataAt?.toISOString() ?? null,
    last_seen_at: d.lastSeenAt?.toISOString() ?? null,
    last_ip: ipById.get(d.id) ?? null,
    revoked_at: d.revokedAt?.toISOString() ?? null,
    revoked_reason: d.revokedReason,
    accounts: d.accounts.map((a) => ({
      id: a.publicId,
      name: a.name,
      last_seen: a.lastSeen.toISOString(),
    })),
  }));
}

/** `api_keys`: the API keys page's list (listApiKeys), never a secret or its hash. */
export async function apiKeysSection(db: Db, userId: string, now: Date) {
  const keys = await listApiKeys(db, userId, now);
  return keys.map((k) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    categories: k.categories,
    account_scope: k.accountScope,
    accounts:
      k.accounts?.map((a) => ({ id: a.publicId, name: a.name, visible: a.visible })) ?? null,
    expires_at: k.expiresAt,
    created_at: k.createdAt,
    last_used_at: k.lastUsedAt,
    revoked_at: k.revokedAt,
    status: k.status,
  }));
}

/** `sign_in_sessions`: the user's web sessions (when, from which address and browser), no tokens. */
export async function signInSessionsSection(db: Db, userId: string) {
  const rows = await db
    .select({
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      expiresAt: session.expiresAt,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
    })
    .from(session)
    .where(eq(session.userId, userId))
    .orderBy(asc(session.createdAt), asc(session.id));
  return rows.map((r) => ({
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
    expires_at: r.expiresAt.toISOString(),
    ip_address: r.ipAddress,
    user_agent: r.userAgent,
  }));
}

/**
 * `sharing`: the settings of the accounts the user owns (the audience per category, who has a grant,
 * who is blocked; the names the owner's sharing panel shows), and the grants other owners gave the
 * user, only where the user can see that category today (resolveAccess), so a grant on a category
 * the owner has since made private reveals nothing.
 */
export async function sharingSection(
  db: Db,
  userId: string,
  viewer: Viewer,
  accounts: readonly AccountWithAccess[],
) {
  const owned = accounts.filter((e) => e.access.relation === 'owner');
  const names = await userNames(
    db,
    owned.flatMap((e) => [
      ...e.raw.grants.map((g) => g.userId),
      ...e.raw.links.filter((l) => l.blocked).map((l) => l.userId),
    ]),
  );
  const nameOf = (id: string) => names.get(id);
  const accountsYouOwn = owned.map(({ account, raw }) => ({
    account: { id: account.publicId, name: account.name },
    categories: CATEGORIES.map((category) => ({
      category,
      audience: effectiveAudience(raw, category),
      is_default: !Object.hasOwn(raw.sharing, category),
      granted_to: sortedNames(
        raw.grants.filter((g) => g.category === category),
        nameOf,
      ),
    })),
    blocked_contributors: sortedNames(
      raw.links.filter((l) => l.blocked),
      nameOf,
    ),
  }));
  return {
    accounts_you_own: accountsYouOwn,
    granted_to_you: await grantsToUser(db, userId, viewer),
  };
}

async function grantsToUser(db: Db, userId: string, viewer: Viewer) {
  const rows = await db
    .select({
      accountId: accountShareGrants.accountId,
      category: accountShareGrants.category,
      createdAt: accountShareGrants.createdAt,
      publicId: osrsAccounts.publicId,
      name: osrsAccounts.currentName,
    })
    .from(accountShareGrants)
    .innerJoin(osrsAccounts, eq(osrsAccounts.id, accountShareGrants.accountId))
    .where(eq(accountShareGrants.granteeUserId, userId))
    .orderBy(asc(osrsAccounts.currentName), asc(osrsAccounts.publicId));
  const access = await loadAccountAccess(
    db,
    rows.map((r) => r.accountId),
  );
  const out = [];
  for (const r of rows) {
    const raw = access.get(r.accountId);
    const resolved = raw ? resolveAccess(viewer, raw) : null;
    if (!resolved?.visible || !resolved.categories.has(r.category as Category)) continue;
    out.push({
      account: { id: r.publicId, name: r.name },
      category: r.category,
      granted_at: r.createdAt.toISOString(),
    });
  }
  return out;
}

async function userNames(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

function sortedNames(
  rows: readonly { userId: string }[],
  nameOf: (id: string) => string | undefined,
): string[] {
  return rows
    .map((r) => nameOf(r.userId))
    .filter((n): n is string => n !== undefined)
    .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

export type AuditRow = Awaited<ReturnType<typeof readAuditPage>>[number];

/**
 * `audit`: every entry the user is the actor or the target (a `user` entry about them) of, oldest
 * first, in pages. Rendered like the admin audit log (listAuditLog): the actor's current name when
 * they still exist; entries anonymized by a hard delete stay as they are.
 */
export function auditPages(db: Db, userId: string, size: number): AsyncGenerator<AuditRow[]> {
  return keysetPages((after, limit) => readAuditPage(db, userId, after?.id ?? null, limit), size);
}

async function readAuditPage(db: Db, userId: string, afterId: number | null, limit: number) {
  const about: SQL | undefined = or(
    eq(auditLog.actorUserId, userId),
    and(eq(auditLog.targetType, 'user'), eq(auditLog.targetId, userId)),
  );
  return db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      actorUserId: auditLog.actorUserId,
      actorName: users.name,
      actorLabel: auditLog.actorLabel,
      action: auditLog.action,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      meta: auditLog.meta,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(afterId === null ? about : and(about, gt(auditLog.id, afterId)))
    .orderBy(asc(auditLog.id))
    .limit(limit);
}

/** What replaces another person's id in an exported audit entry. */
export const REDACTED_ID = '[redacted]';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Which ids an exported audit entry may keep: the user's own, and everyone else's user ids. */
export interface AuditIds {
  /** The user's id and their devices' and API keys' ids: kept. */
  own: ReadonlySet<string>;
  /** Every other user's id (Better Auth ids are random strings, not uuids): redacted. */
  others: ReadonlySet<string>;
}

/** The ids wireAuditFor needs; one query per table (a guild has hundreds of users, not millions). */
export async function auditIds(db: Db, userId: string): Promise<AuditIds> {
  const [deviceRows, keyRows, userRows] = await Promise.all([
    db.select({ id: devices.id }).from(devices).where(eq(devices.userId, userId)),
    db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.userId, userId)),
    db.select({ id: users.id }).from(users),
  ]);
  return {
    own: new Set([userId, ...deviceRows.map((r) => r.id), ...keyRows.map((r) => r.id)]),
    others: new Set(userRows.map((r) => r.id).filter((id) => id !== userId)),
  };
}

/**
 * An audit entry as exported (D-79: nothing about other people beyond the names the hub shows). The
 * actor's name stays, their id only when it is the user; a `user` target other than the user, every
 * other user's id in `meta` (a grantee, a transfer's other side), and every uuid in `meta` that isn't
 * one of the user's own (someone else's device or key) become REDACTED_ID. Numbers and other
 * strings are kept.
 */
export function wireAuditFor(userId: string, ids: AuditIds) {
  const redact = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const foreign = ids.others.has(value) || (UUID_RE.test(value) && !ids.own.has(value));
      return foreign ? REDACTED_ID : value;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
    }
    return value;
  };
  return (r: AuditRow) => ({
    id: r.id,
    at: r.at.toISOString(),
    actor_user_id: r.actorUserId === userId ? userId : null,
    actor_name: r.actorName,
    actor_label: r.actorLabel,
    action: r.action,
    target_type: r.targetType,
    target_id: r.targetType === 'user' && r.targetId !== userId ? REDACTED_ID : r.targetId,
    meta: redact(r.meta),
  });
}
