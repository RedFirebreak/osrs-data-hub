import { users } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedAudit, seedUser } from '../offboarding/test-support';
import { AUDIT_LOG_PAGE_MAX, listAuditLog } from './audit-log';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase('adminaudit');
});

afterAll(async () => {
  await t.drop();
});

describe('listAuditLog', () => {
  it('lists entries newest first with the actor name, and pages by id', async () => {
    const alice = await seedUser(t.db, { name: 'Alice' });
    const gone = await seedUser(t.db, { name: 'Gone' });
    const at = new Date('2026-09-28T12:00:00Z');
    const first = await seedAudit(t.db, { action: 'a.first', at, actorLabel: 'system' });
    const second = await seedAudit(t.db, {
      action: 'b.second',
      at,
      actorUserId: alice,
      targetType: 'user',
      targetId: 'x',
      meta: { n: 1 },
    });
    const third = await seedAudit(t.db, { action: 'c.third', at, actorUserId: gone });
    await t.db.delete(users).where(eq(users.id, gone));

    const all = await listAuditLog(t.db, { limit: 10 });
    expect(all.map((e) => e.id)).toEqual([third, second, first]);
    expect(all[1]).toEqual({
      id: second,
      at,
      actorUserId: alice,
      actorName: 'Alice',
      actorLabel: null,
      action: 'b.second',
      targetType: 'user',
      targetId: 'x',
      meta: { n: 1 },
    });
    // The FK anonymizes a deleted actor.
    expect(all[0]).toMatchObject({ actorUserId: null, actorName: null });
    expect(all[2]).toMatchObject({ actorUserId: null, actorName: null, actorLabel: 'system' });

    const page = await listAuditLog(t.db, { limit: 1, before: third });
    expect(page.map((e) => e.id)).toEqual([second]);
    expect(await listAuditLog(t.db, { limit: 10, before: first })).toEqual([]);
    expect(await listAuditLog(t.db, { limit: 0 })).toHaveLength(1);
    expect(await listAuditLog(t.db, { limit: 10, before: Number.NaN })).toHaveLength(3);
  });

  it('caps a page at AUDIT_LOG_PAGE_MAX entries', async () => {
    await t.db.execute(
      sql`INSERT INTO audit_log (action) SELECT 'bulk' FROM generate_series(1, ${AUDIT_LOG_PAGE_MAX + 1})`,
    );
    expect(await listAuditLog(t.db, { limit: 100_000 })).toHaveLength(AUDIT_LOG_PAGE_MAX);
    expect(await listAuditLog(t.db, { limit: Number.POSITIVE_INFINITY })).toHaveLength(
      AUDIT_LOG_PAGE_MAX,
    );
  });
});
