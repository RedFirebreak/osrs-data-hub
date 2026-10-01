import { MIN_XP_RAW_RETENTION_DAYS, parseConfig } from '@hub/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAGG_REFRESH_START_DAYS, applyTimescalePolicies, validatePolicyConfig } from './policies';
import { createTestDatabase, type TestDatabase } from './testing';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('policies');
});
afterAll(async () => {
  await t?.drop();
});

const base = { xpRawRetentionDays: 365, locationRetentionDays: 30, rawPayloadRetentionHours: 72 };

describe('applyTimescalePolicies', () => {
  it('adds all seven policies, then is a no-op, then replaces only what changed', async () => {
    const first = await applyTimescalePolicies(t.db, base);
    expect(first).toHaveLength(7);
    expect(await applyTimescalePolicies(t.db, base)).toEqual([]);
    const changed = await applyTimescalePolicies(t.db, { ...base, locationRetentionDays: 14 });
    expect(changed).toEqual(['retention location_samples 14 days']);
    const jobs = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM timescaledb_information.jobs WHERE hypertable_schema = 'public'`,
    );
    expect(jobs.rows[0]!.n).toBe(7);
  });

  it('refuses a raw XP retention inside the aggregate refresh window', () => {
    expect(() => validatePolicyConfig({ ...base, xpRawRetentionDays: 7 })).toThrow(/at least 14/);
    expect(() => validatePolicyConfig({ ...base, rawPayloadRetentionHours: 1.5 })).toThrow();
  });

  it('shares its XP retention minimum with the config: twice the refresh window (TSDB-1)', () => {
    expect(MIN_XP_RAW_RETENTION_DAYS).toBe(CAGG_REFRESH_START_DAYS * 2);
    const atMinimum = { ...base, xpRawRetentionDays: MIN_XP_RAW_RETENTION_DAYS };
    expect(() => validatePolicyConfig(atMinimum)).not.toThrow();
    expect(() => validatePolicyConfig({ ...base, xpRawRetentionDays: 13 })).toThrow(/at least 14/);
    const env = (days: number) => ({ XP_RAW_RETENTION_DAYS: String(days) });
    expect(parseConfig(env(MIN_XP_RAW_RETENTION_DAYS)).xpRawRetentionDays).toBe(14);
    expect(() => parseConfig(env(13))).toThrow('XP_RAW_RETENTION_DAYS: must be at least 14');
  });
});
