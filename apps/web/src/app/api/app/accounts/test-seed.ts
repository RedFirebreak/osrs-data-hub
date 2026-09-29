/**
 * Seeding helpers for the account, feed and members route tests and the account/guild page tests
 * (imported by *.test.ts(x) only). Rows are inserted directly, so each test states exactly what it
 * relies on; the routes themselves only ever read through the @hub/server read models.
 *
 *   const seed = accountSeeder(ctx.t.db);
 *   const acc = await seed.account({ owner: ownerId, name: 'Zezima' });
 *   await seed.latestState(acc.id, { lastSeen: new Date(), skills: skillMap({ Attack: [83, 2] }) });
 */
import { randomUUID } from 'node:crypto';
import type { Audience, Category } from '@hub/core';
import {
  accountLinks,
  accountNames,
  accountShareGrants,
  accountSharing,
  equipmentChanges,
  events,
  latestState,
  locationSamples,
  osrsAccounts,
  playSessions,
  skills,
  wealthDaily,
  xpSamples,
  type AccountStatus,
  type Db,
  type SessionEndReason,
} from '@hub/db';

export interface SeededAccount {
  id: number;
  publicId: string;
  name: string;
}

let counter = 0;

/** A unique 12-character base62-ish public id (D-46 shape). */
export function testPublicId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

/** latest_state.skills as the plugin sends them: { Attack: [xp, level] } → { Attack: { xp, level } }. */
export function skillMap(
  entries: Record<string, [xp: number, level: number]>,
): Record<string, { xp: number; level: number }> {
  return Object.fromEntries(
    Object.entries(entries).map(([name, [xp, level]]) => [name, { xp, level }]),
  );
}

export function accountSeeder(db: Db) {
  const skillIds = new Map<string, number>();

  async function skillId(name: string): Promise<number> {
    if (skillIds.size === 0) {
      for (const row of await db.select({ id: skills.id, name: skills.name }).from(skills)) {
        skillIds.set(row.name, row.id);
      }
    }
    const id = skillIds.get(name);
    if (id === undefined) throw new Error(`unknown skill ${name}`);
    return id;
  }

  async function link(
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

  return {
    /**
     * An account; with `owner`, the owner also gets an 'owner' link (as ingest creates it), and each
     * of `contributors` a 'contributor' link.
     */
    async account(
      opts: {
        name?: string;
        owner?: string | null;
        contributors?: string[];
        status?: AccountStatus;
        accountType?: number | null;
        firstSeen?: Date;
        lastSeen?: Date;
      } = {},
    ): Promise<SeededAccount> {
      const name = opts.name ?? `Account ${++counter}`;
      const publicId = testPublicId();
      const [row] = await db
        .insert(osrsAccounts)
        .values({
          publicId,
          accountHash: randomUUID(),
          currentName: name,
          nameNormalized: name.toLowerCase(),
          accountType: opts.accountType === undefined ? 0 : opts.accountType,
          ownerUserId: opts.owner ?? null,
          status: opts.status ?? 'active',
          hiddenAt: opts.status === 'hidden' ? new Date() : null,
          ...(opts.firstSeen ? { firstSeen: opts.firstSeen } : {}),
          ...(opts.lastSeen ? { lastSeen: opts.lastSeen } : {}),
        })
        .returning({ id: osrsAccounts.id });
      if (!row) throw new Error('seed.account: no row');
      if (opts.owner) await link(row.id, opts.owner, { role: 'owner' });
      for (const userId of opts.contributors ?? []) await link(row.id, userId);
      return { id: row.id, publicId, name };
    },

    link,

    async name(accountId: number, name: string, lastSeen: Date): Promise<void> {
      await db
        .insert(accountNames)
        .values({ accountId, name, firstSeen: lastSeen, lastSeen })
        .onConflictDoNothing();
    },

    async sharing(accountId: number, category: Category, audience: Audience): Promise<void> {
      await db.insert(accountSharing).values({ accountId, category, audience });
    },

    async grant(accountId: number, category: Category, granteeUserId: string): Promise<void> {
      await db.insert(accountShareGrants).values({ accountId, category, granteeUserId });
    },

    async latestState(
      accountId: number,
      values: Partial<typeof latestState.$inferInsert> & { lastSeen: Date },
    ): Promise<void> {
      await db
        .insert(latestState)
        .values({ accountId, ...values })
        .onConflictDoUpdate({ target: latestState.accountId, set: values });
    },

    /** xp_samples rows: [skill, bucket (5-minute aligned), xp]. */
    async xp(accountId: number, samples: [skill: string, bucket: string | Date, xp: number][]) {
      const rows = [];
      for (const [skill, bucket, xp] of samples) {
        rows.push({
          accountId,
          skillId: await skillId(skill),
          bucket: new Date(bucket),
          xp,
          level: 1,
        });
      }
      if (rows.length > 0) await db.insert(xpSamples).values(rows);
    },

    async event(
      accountId: number,
      values: Partial<typeof events.$inferInsert> & { type: string },
    ): Promise<{ id: string; seq: number }> {
      const at = values.occurredAt ?? new Date();
      const [row] = await db
        .insert(events)
        .values({
          pluginEventId: randomUUID(),
          accountId,
          occurredAt: at,
          receivedAt: values.receivedAt ?? at,
          data: { type: values.type, data: {}, eventId: randomUUID(), timestamp: at.getTime() },
          ...values,
        })
        .returning({ id: events.id, seq: events.seq });
      if (!row) throw new Error('seed.event: no row');
      return row;
    },

    async session(
      accountId: number,
      values: {
        startedAt: Date;
        lastSeenAt?: Date;
        endedAt?: Date | null;
        endReason?: SessionEndReason | null;
        worlds?: number[];
      },
    ): Promise<void> {
      await db.insert(playSessions).values({
        accountId,
        startedAt: values.startedAt,
        lastSeenAt: values.lastSeenAt ?? values.endedAt ?? values.startedAt,
        endedAt: values.endedAt ?? null,
        endReason: values.endReason ?? null,
        worlds: values.worlds ?? [],
      });
    },

    async equipmentChange(accountId: number, changedAt: Date, equipment: unknown[]): Promise<void> {
      await db.insert(equipmentChanges).values({ accountId, changedAt, equipment });
    },

    async wealth(accountId: number, day: string, lastValue: number, maxValue: number) {
      await db.insert(wealthDaily).values({ accountId, day, lastValue, maxValue });
    },

    async location(
      accountId: number,
      ts: Date,
      point: { x: number; y: number; plane?: number; world?: number | null; onBoat?: boolean },
    ): Promise<void> {
      await db.insert(locationSamples).values({
        accountId,
        ts,
        x: point.x,
        y: point.y,
        plane: point.plane ?? 0,
        world: point.world ?? null,
        onBoat: point.onBoat ?? false,
      });
    },
  };
}

export type AccountSeeder = ReturnType<typeof accountSeeder>;
