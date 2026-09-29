import { auditLog } from '@hub/db';
import { createTestDatabase, type TestDatabase } from '@hub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedAudit } from '../offboarding/test-support';
import { pruneAuditLog } from './audit-log';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase('pruneaudit');
});

afterAll(async () => {
  await t.drop();
});

const NOW = new Date('2026-09-28T12:00:00Z');
const DAY = 86_400_000;

describe('pruneAuditLog', () => {
  it('deletes entries older than the retention and keeps the rest', async () => {
    const cutoff = NOW.getTime() - 730 * DAY;
    const ages = {
      ancient: new Date(cutoff - 365 * DAY),
      justOlder: new Date(cutoff - 1),
      atCutoff: new Date(cutoff),
      recent: new Date(NOW.getTime() - DAY),
    };
    for (const [action, at] of Object.entries(ages)) await seedAudit(t.db, { action, at });

    expect(await pruneAuditLog(t.db, { retentionDays: 730, now: NOW })).toEqual({ deleted: 2 });
    const left = await t.db.select({ action: auditLog.action }).from(auditLog);
    expect(left.map((r) => r.action).sort()).toEqual(['atCutoff', 'recent']);

    expect(await pruneAuditLog(t.db, { retentionDays: 730, now: NOW })).toEqual({ deleted: 0 });
  });

  it('refuses a retention that would empty the log', async () => {
    for (const retentionDays of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(pruneAuditLog(t.db, { retentionDays, now: NOW })).rejects.toThrow(RangeError);
    }
  });
});
