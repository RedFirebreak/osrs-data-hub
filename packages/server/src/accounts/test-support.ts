/**
 * Seeding helpers for the accounts and sharing tests (not exported from the package). Everything is
 * inserted directly, so each test states exactly the rows it relies on.
 */
import { randomUUID } from 'node:crypto';
import type { Audience, Category, Viewer } from '@hub/core';
import {
  accountLinks,
  accountShareGrants,
  accountSharing,
  events,
  latestState,
  osrsAccounts,
  skills,
  users,
  xpSamples,
  type AccountStatus,
  type Db,
  type UserStatus,
} from '@hub/db';
import { sql } from 'drizzle-orm';

let counter = 0;

export interface SeededUser {
  id: string;
  viewer: Viewer;
}

/** Inserts a user; `viewer` is what loadViewer would return for it. */
export async function seedUser(
  db: Db,
  opts: { name?: string; status?: UserStatus; isAdmin?: boolean; image?: string | null } = {},
): Promise<SeededUser> {
  const id = `u${++counter}-${randomUUID().slice(0, 8)}`;
  const status = opts.status ?? 'active';
  const isAdmin = opts.isAdmin ?? false;
  await db.insert(users).values({
    id,
    name: opts.name ?? `User ${counter}`,
    email: `${id}@discord.invalid`,
    image: opts.image ?? null,
    status,
    isAdmin,
  });
  return { id, viewer: { userId: id, status, isAdmin } };
}

export interface SeededAccount {
  id: number;
  publicId: string;
  name: string;
}

/**
 * Inserts an account. With `owner`, the owner also gets an 'owner' link (as ingest would create), and
 * each of `contributors` a 'contributor' link.
 */
export async function seedAccount(
  db: Db,
  opts: {
    name?: string;
    owner?: string | null;
    contributors?: string[];
    status?: AccountStatus;
    /** D-104. */
    hiddenFromGuild?: boolean;
    accountType?: number | null;
    firstSeen?: Date;
    lastSeen?: Date;
  } = {},
): Promise<SeededAccount> {
  const name = opts.name ?? `Account ${++counter}`;
  const publicId = randomUUID().replace(/-/g, '').slice(0, 12);
  const [row] = await db
    .insert(osrsAccounts)
    .values({
      publicId,
      accountHash: randomUUID(),
      currentName: name,
      nameNormalized: name.toLowerCase(),
      accountType: opts.accountType ?? 0,
      ownerUserId: opts.owner ?? null,
      status: opts.status ?? 'active',
      hiddenAt: opts.status === 'hidden' ? new Date() : null,
      hiddenFromGuild: opts.hiddenFromGuild ?? false,
      ...(opts.firstSeen ? { firstSeen: opts.firstSeen } : {}),
      ...(opts.lastSeen ? { lastSeen: opts.lastSeen } : {}),
    })
    .returning({ id: osrsAccounts.id });
  if (!row) throw new Error('seedAccount: no row');
  if (opts.owner) await seedLink(db, row.id, opts.owner, { role: 'owner' });
  for (const userId of opts.contributors ?? []) await seedLink(db, row.id, userId);
  return { id: row.id, publicId, name };
}

export async function seedLink(
  db: Db,
  accountId: number,
  userId: string,
  opts: { role?: 'owner' | 'contributor'; blocked?: boolean; firstSeen?: Date } = {},
): Promise<void> {
  await db.insert(accountLinks).values({
    accountId,
    userId,
    role: opts.role ?? 'contributor',
    blocked: opts.blocked ?? false,
    blockedAt: opts.blocked ? new Date() : null,
    ...(opts.firstSeen ? { firstSeen: opts.firstSeen, lastSeen: opts.firstSeen } : {}),
  });
}

/** Sets the audience of one category; a second call for the same category replaces the first. */
export async function seedSharing(
  db: Db,
  accountId: number,
  category: Category,
  audience: Audience,
): Promise<void> {
  await db
    .insert(accountSharing)
    .values({ accountId, category, audience })
    .onConflictDoUpdate({
      target: [accountSharing.accountId, accountSharing.category],
      set: { audience },
    });
}

export async function seedGrant(
  db: Db,
  accountId: number,
  category: Category,
  granteeUserId: string,
): Promise<void> {
  await db.insert(accountShareGrants).values({ accountId, category, granteeUserId });
}

export async function seedLatestState(
  db: Db,
  accountId: number,
  values: Partial<typeof latestState.$inferInsert> & { lastSeen: Date },
): Promise<void> {
  await db
    .insert(latestState)
    .values({ accountId, ...values })
    .onConflictDoUpdate({ target: latestState.accountId, set: values });
}

/** latest_state.skills as the plugin sends them. */
export function skillMap(
  entries: Record<string, [xp: number, level: number]>,
): Record<string, { xp: number; level: number }> {
  return Object.fromEntries(
    Object.entries(entries).map(([name, [xp, level]]) => [name, { xp, level }]),
  );
}

const skillIdCache = new WeakMap<Db, Map<string, number>>();

export async function skillId(db: Db, name: string): Promise<number> {
  let ids = skillIdCache.get(db);
  if (!ids) {
    const rows = await db.select({ id: skills.id, name: skills.name }).from(skills);
    ids = new Map(rows.map((r) => [r.name, r.id]));
    skillIdCache.set(db, ids);
  }
  const id = ids.get(name);
  if (id === undefined) throw new Error(`unknown skill ${name}`);
  return id;
}

/** Inserts xp_samples rows: [skill, bucket (5-minute aligned), xp]. */
export async function seedXp(
  db: Db,
  accountId: number,
  samples: [skill: string, bucket: string | Date, xp: number][],
): Promise<void> {
  const rows = [];
  for (const [skill, bucket, xp] of samples) {
    rows.push({
      accountId,
      skillId: await skillId(db, skill),
      bucket: new Date(bucket),
      xp,
      level: 1,
    });
  }
  if (rows.length > 0) await db.insert(xpSamples).values(rows);
}

/** Materializes both XP aggregates (must run outside a transaction; TSDB-7). */
export async function refreshXpAggregates(db: Db): Promise<void> {
  await db.execute(sql`CALL refresh_continuous_aggregate('xp_hourly', NULL, NULL)`);
  await db.execute(sql`CALL refresh_continuous_aggregate('xp_daily', NULL, NULL)`);
}

export async function seedEvent(
  db: Db,
  accountId: number,
  values: Partial<typeof events.$inferInsert> & { type: string } = { type: 'loot' },
): Promise<{ id: string; seq: number }> {
  const at = values.occurredAt ?? new Date('2026-09-28T11:00:00Z');
  const [row] = await db
    .insert(events)
    .values({
      pluginEventId: randomUUID(),
      accountId,
      occurredAt: at,
      receivedAt: values.receivedAt ?? at,
      data: { type: values.type, data: {}, eventId: 'x', timestamp: at.getTime() },
      ...values,
    })
    .returning({ id: events.id, seq: events.seq });
  if (!row) throw new Error('seedEvent: no row');
  return row;
}

/** A stored death event whose data carries coordinates (redacted without a location category). */
export function deathData(): Record<string, unknown> {
  return {
    type: 'death',
    eventId: randomUUID(),
    timestamp: 0,
    data: { valueLost: 34906, danger: 'DANGEROUS', location: { x: 3068, y: 3858, plane: 0 } },
  };
}

/** A stored superior spawn event with coordinates. */
export function superiorData(): Record<string, unknown> {
  return {
    type: 'superiorSpawn',
    eventId: randomUUID(),
    timestamp: 0,
    data: { name: 'Nechryarch', npcId: 7411, location: { x: 1698, y: 10082, plane: 0 } },
  };
}
