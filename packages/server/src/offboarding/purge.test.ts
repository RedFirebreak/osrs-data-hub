import { auditLog, events, osrsAccounts, users } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestMetrics } from '../metrics';
import { countsBy } from '../metrics-test-support';
import { accountMaterializationTables } from './expire';
import { purgeAccount, purgeOrphanedAccounts } from './purge';
import {
  refreshXpAggregates,
  seedAccount,
  seedLink,
  seedUser,
  seedXp,
  type SeededAccount,
} from './test-support';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase('purge');
});

afterAll(async () => {
  await t.drop();
});

const NOW = new Date('2026-09-28T12:00:00Z');
const DAY = 86_400_000;
const GRACE_DAYS = 30;
const OLD = new Date(NOW.getTime() - (GRACE_DAYS + 1) * DAY);
const RECENT = new Date(NOW.getTime() - (GRACE_DAYS - 1) * DAY);

async function setTimes(a: SeededAccount, times: { lastSeen?: Date; hiddenAt?: Date | null }) {
  await t.db
    .update(osrsAccounts)
    .set({
      ...(times.lastSeen ? { lastSeen: times.lastSeen } : {}),
      ...(times.hiddenAt !== undefined
        ? { hiddenAt: times.hiddenAt, status: times.hiddenAt ? 'hidden' : 'active' }
        : {}),
    })
    .where(eq(osrsAccounts.id, a.id));
}

async function exists(a: SeededAccount): Promise<boolean> {
  const rows = await t.db
    .select({ id: osrsAccounts.id })
    .from(osrsAccounts)
    .where(eq(osrsAccounts.id, a.id));
  return rows.length === 1;
}

async function materializedCount(accountId: number): Promise<number> {
  let n = 0;
  for (const m of await accountMaterializationTables(t.db)) {
    const res = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(m.schema)}.${sql.identifier(m.name)} WHERE account_id = ${accountId}`,
    );
    n += res.rows[0]?.n ?? 0;
  }
  return n;
}

describe('purgeOrphanedAccounts (D-61)', () => {
  it('purges orphans past the gate and keeps everything a user can still reclaim', async () => {
    const active = await seedUser(t.db, { name: 'Active' });
    const blocked = await seedUser(t.db, { name: 'Blocked' });
    const inGrace = await seedUser(t.db, { name: 'In grace', status: 'grace' });

    // A bare row from a refused first payload: no owner, no link, unseen for longer than the gate.
    const bareOld = await seedAccount(t.db);
    await setTimes(bareOld, { lastSeen: OLD });
    // The same, but seen recently: its resend may still fill it in.
    const bareRecent = await seedAccount(t.db);
    await setTimes(bareRecent, { lastSeen: RECENT });
    // No owner, only a blocked contributor: nobody can take it over.
    const onlyBlocked = await seedAccount(t.db);
    await seedLink(t.db, onlyBlocked.id, blocked, { blocked: true });
    await setTimes(onlyBlocked, { lastSeen: OLD, hiddenAt: OLD });
    // Hidden recently (gate counts from hidden_at even when last_seen is old).
    const hiddenRecently = await seedAccount(t.db);
    await setTimes(hiddenRecently, { lastSeen: OLD, hiddenAt: RECENT });
    // No owner but a non-blocked contributor (their next payload claims it).
    const withContributor = await seedAccount(t.db);
    await seedLink(t.db, withContributor.id, active);
    await setTimes(withContributor, { lastSeen: OLD });
    // An active owner who stopped playing: kept forever (retention is forever for them).
    const activeOwner = await seedAccount(t.db, { owner: active });
    await setTimes(activeOwner, { lastSeen: OLD });
    // Hidden because its owner is in grace: that owner's grace expiry settles it, not the purge.
    const ownerInGrace = await seedAccount(t.db, { owner: inGrace });
    await setTimes(ownerInGrace, { lastSeen: OLD, hiddenAt: OLD });

    const metrics = createTestMetrics();
    const result = await purgeOrphanedAccounts(t.db, { graceDays: GRACE_DAYS, now: NOW, metrics });

    expect(result).toEqual({ purged: 2 });
    expect(await countsBy(metrics.accountsDeleted, 'cause')).toEqual({ orphan_purge: 2 });
    expect(await exists(bareOld)).toBe(false);
    expect(await exists(onlyBlocked)).toBe(false);
    for (const kept of [bareRecent, hiddenRecently, withContributor, activeOwner, ownerInGrace]) {
      expect(await exists(kept)).toBe(true);
    }
    // The blocked user stays; only the link to the purged account went away.
    expect(await t.db.select().from(users).where(eq(users.id, blocked))).toHaveLength(1);

    const audits = await t.db
      .select({
        targetId: auditLog.targetId,
        meta: auditLog.meta,
        actorUserId: auditLog.actorUserId,
      })
      .from(auditLog)
      .where(eq(auditLog.action, 'account.purged'));
    expect(audits.map((a) => a.targetId).sort()).toEqual(
      [bareOld.publicId, onlyBlocked.publicId].sort(),
    );
    expect(audits.every((a) => a.actorUserId === null)).toBe(true);
    expect(audits.find((a) => a.targetId === onlyBlocked.publicId)?.meta).toMatchObject({
      reason: 'orphaned',
      wasHidden: true,
      graceDays: GRACE_DAYS,
    });
  });

  it('is a no-op on a second run', async () => {
    expect(await purgeOrphanedAccounts(t.db, { graceDays: GRACE_DAYS, now: NOW })).toEqual({
      purged: 0,
    });
  });

  it('deletes the raw data and the continuous aggregates’ materialized rows (TSDB-2)', async () => {
    const orphan = await seedAccount(t.db);
    await seedXp(t.db, orphan.id, [
      '2026-01-10T10:00:00Z',
      '2026-01-10T11:05:00Z',
      '2026-01-11T09:00:00Z',
    ]);
    await t.db.insert(events).values({
      pluginEventId: 'e-1',
      accountId: orphan.id,
      type: 'loot',
      occurredAt: OLD,
      receivedAt: OLD,
      data: { type: 'loot' },
    });
    await refreshXpAggregates(t.db);
    expect(await materializedCount(orphan.id)).toBeGreaterThan(0);
    await setTimes(orphan, { lastSeen: OLD });

    expect(await purgeOrphanedAccounts(t.db, { graceDays: GRACE_DAYS, now: NOW })).toEqual({
      purged: 1,
    });

    expect(await materializedCount(orphan.id)).toBe(0);
    const left = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM xp_samples WHERE account_id = ${orphan.id}`,
    );
    expect(left.rows[0]?.n).toBe(0);
    expect(await t.db.select().from(events).where(eq(events.accountId, orphan.id))).toHaveLength(0);
  });

  it('keeps an account that gained a link after it was picked (re-check under the account lock)', async () => {
    const user = await seedUser(t.db, { name: 'Late reporter' });
    const orphan = await seedAccount(t.db);
    await setTimes(orphan, { lastSeen: OLD });
    // Picked as a candidate, then a payload links a user before the purge takes the lock.
    await seedLink(t.db, orphan.id, user);
    const caggTables = await accountMaterializationTables(t.db);
    const deleted = await t.db.transaction((tx) =>
      purgeAccount(tx, orphan.id, {
        cutoff: new Date(NOW.getTime() - GRACE_DAYS * DAY),
        graceDays: GRACE_DAYS,
        caggTables,
      }),
    );
    expect(deleted).toBe(false);
    expect(await exists(orphan)).toBe(true);
  });

  it('honours the batch size', async () => {
    const orphans = [await seedAccount(t.db), await seedAccount(t.db), await seedAccount(t.db)];
    for (const o of orphans) await setTimes(o, { lastSeen: OLD });
    expect(
      await purgeOrphanedAccounts(t.db, { graceDays: GRACE_DAYS, now: NOW, batchSize: 2 }),
    ).toEqual({
      purged: 2,
    });
    const left = await t.db
      .select({ id: osrsAccounts.id })
      .from(osrsAccounts)
      .where(
        inArray(
          osrsAccounts.id,
          orphans.map((o) => o.id),
        ),
      );
    expect(left).toHaveLength(1);
  });

  it('rejects a negative or fractional grace', async () => {
    await expect(purgeOrphanedAccounts(t.db, { graceDays: -1, now: NOW })).rejects.toThrow(
      /graceDays/,
    );
    await expect(purgeOrphanedAccounts(t.db, { graceDays: 1.5, now: NOW })).rejects.toThrow(
      /graceDays/,
    );
  });
});
