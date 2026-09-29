/**
 * Seeding helpers for the offboarding, jobs and admin tests (not exported from the package). Rows
 * are inserted directly, so each test states exactly what it relies on.
 */
import { randomUUID } from 'node:crypto';
import {
  accountLinks,
  apiKeys,
  auditLog,
  devices,
  osrsAccounts,
  session,
  skills,
  users,
  xpSamples,
  type AccountStatus,
  type Db,
  type OffboardReason,
  type UserStatus,
} from '@hub/db';
import { sql } from 'drizzle-orm';
import pino, { type Logger } from 'pino';

let counter = 0;

export async function seedUser(
  db: Db,
  opts: {
    name?: string;
    status?: UserStatus;
    discordId?: string | null;
    isAdmin?: boolean;
    graceUntil?: Date | null;
    offboardReason?: OffboardReason | null;
    lastVerifiedAt?: Date | null;
    verifyFailures?: number;
    roles?: string[];
    image?: string | null;
  } = {},
): Promise<string> {
  const id = `u${++counter}-${randomUUID().slice(0, 8)}`;
  await db.insert(users).values({
    id,
    name: opts.name ?? `User ${counter}`,
    email: `${id}@discord.invalid`,
    image: opts.image ?? null,
    discordId: opts.discordId === undefined ? null : opts.discordId,
    isAdmin: opts.isAdmin ?? false,
    status: opts.status ?? 'active',
    graceUntil: opts.graceUntil ?? null,
    offboardReason: opts.offboardReason ?? null,
    lastVerifiedAt: opts.lastVerifiedAt ?? null,
    verifyFailures: opts.verifyFailures ?? 0,
    roles: opts.roles ?? [],
  });
  return id;
}

export async function seedDevice(
  db: Db,
  userId: string,
  values: Partial<typeof devices.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(devices)
    .values({ userId, tokenHash: randomUUID(), ...values })
    .returning({ id: devices.id });
  if (!row) throw new Error('seedDevice: no row');
  return row.id;
}

export async function seedApiKey(db: Db, userId: string): Promise<string> {
  const [row] = await db
    .insert(apiKeys)
    .values({
      userId,
      name: 'key',
      prefix: randomUUID().slice(0, 12),
      secretHash: randomUUID(),
      categories: ['stats'],
    })
    .returning({ id: apiKeys.id });
  if (!row) throw new Error('seedApiKey: no row');
  return row.id;
}

/** A Better Auth `session` row. */
export async function seedSession(db: Db, userId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(session).values({
    id,
    userId,
    token: randomUUID(),
    expiresAt: new Date('2027-01-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  });
  return id;
}

export interface SeededAccount {
  id: number;
  publicId: string;
}

/** An account; with `owner`, the owner also gets an 'owner' link (as ingest creates it). */
export async function seedAccount(
  db: Db,
  opts: { owner?: string | null; status?: AccountStatus; ownerLinkFirstSeen?: Date } = {},
): Promise<SeededAccount> {
  const publicId = randomUUID().replace(/-/g, '').slice(0, 12);
  const [row] = await db
    .insert(osrsAccounts)
    .values({
      publicId,
      accountHash: randomUUID(),
      currentName: `Acc ${++counter}`,
      nameNormalized: `acc ${counter}`,
      ownerUserId: opts.owner ?? null,
      status: opts.status ?? 'active',
      hiddenAt: opts.status === 'hidden' ? new Date('2026-09-01T00:00:00Z') : null,
    })
    .returning({ id: osrsAccounts.id });
  if (!row) throw new Error('seedAccount: no row');
  if (opts.owner) {
    await seedLink(db, row.id, opts.owner, {
      role: 'owner',
      firstSeen: opts.ownerLinkFirstSeen ?? new Date('2025-01-01T00:00:00Z'),
    });
  }
  return { id: row.id, publicId };
}

export async function seedLink(
  db: Db,
  accountId: number,
  userId: string,
  opts: { role?: 'owner' | 'contributor'; blocked?: boolean; firstSeen?: Date } = {},
): Promise<void> {
  const firstSeen = opts.firstSeen ?? new Date('2026-01-01T00:00:00Z');
  await db.insert(accountLinks).values({
    accountId,
    userId,
    role: opts.role ?? 'contributor',
    blocked: opts.blocked ?? false,
    blockedAt: opts.blocked ? firstSeen : null,
    firstSeen,
    lastSeen: firstSeen,
  });
}

export async function seedAudit(
  db: Db,
  values: Partial<typeof auditLog.$inferInsert> & { action: string },
): Promise<number> {
  const [row] = await db.insert(auditLog).values(values).returning({ id: auditLog.id });
  if (!row) throw new Error('seedAudit: no row');
  return row.id;
}

/** Inserts xp_samples for Attack at the given (5-minute aligned) buckets. */
export async function seedXp(db: Db, accountId: number, buckets: string[]): Promise<void> {
  const [attack] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(sql`${skills.name} = 'Attack'`);
  if (!attack) throw new Error('seedXp: no Attack skill');
  await db.insert(xpSamples).values(
    buckets.map((b, i) => ({
      accountId,
      skillId: attack.id,
      bucket: new Date(b),
      xp: 1000 * (i + 1),
      level: 10,
    })),
  );
}

/** Materializes both XP aggregates (CALL must run outside a transaction; DB-7, TSDB-7). */
export async function refreshXpAggregates(db: Db): Promise<void> {
  await db.execute(sql`CALL refresh_continuous_aggregate('xp_hourly', NULL, NULL)`);
  await db.execute(sql`CALL refresh_continuous_aggregate('xp_daily', NULL, NULL)`);
}

export interface LogLine {
  level: number;
  msg: string;
  [key: string]: unknown;
}

/** A pino logger whose JSON lines are kept in `lines` (30 info, 40 warn, 50 error). */
export function captureLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const logger = pino(
    { level: 'trace' },
    { write: (msg: string) => void lines.push(JSON.parse(msg) as LogLine) },
  );
  return { logger, lines };
}
