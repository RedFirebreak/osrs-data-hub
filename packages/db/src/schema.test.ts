import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing';
import { osrsAccounts, skills, xpSamples } from './schema';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('schema');
});
afterAll(async () => {
  await t?.drop();
});

describe('migrations', () => {
  it('creates the hypertables and continuous aggregates', async () => {
    const hts = await t.db.execute<{ hypertable_name: string }>(
      sql`SELECT hypertable_name FROM timescaledb_information.hypertables ORDER BY 1`,
    );
    expect(hts.rows.map((r) => r.hypertable_name)).toEqual([
      'location_samples',
      'raw_payloads',
      'xp_samples',
    ]);
    const caggs = await t.db.execute<{ view_name: string; materialized_only: boolean }>(
      sql`SELECT view_name, materialized_only FROM timescaledb_information.continuous_aggregates ORDER BY 1`,
    );
    expect(caggs.rows).toEqual([
      { view_name: 'xp_daily', materialized_only: false },
      { view_name: 'xp_hourly', materialized_only: false },
    ]);
  });

  it('seeds the skills in plugin order with Overall first', async () => {
    const rows = await t.db.select().from(skills).orderBy(skills.sortOrder);
    expect(rows[0]).toMatchObject({ name: 'Overall', kind: 'derived' });
    expect(rows).toHaveLength(25);
    expect(rows.at(-1)).toMatchObject({ name: 'Sailing', kind: 'plugin', sortOrder: 24 });
  });

  it('upserts XP with GREATEST and rolls up with last()', async () => {
    const [acc] = await t.db
      .insert(osrsAccounts)
      .values({ publicId: 'p1', accountHash: 'h'.repeat(56), currentName: 'Zezima', nameNormalized: 'zezima' })
      .returning({ id: osrsAccounts.id });
    const accountId = acc!.id;
    const bucket = new Date('2026-09-28T10:05:00Z');
    const upsert = (xp: number) =>
      t.db
        .insert(xpSamples)
        .values({ accountId, skillId: 1, bucket, xp, level: 1 })
        .onConflictDoUpdate({
          target: [xpSamples.accountId, xpSamples.skillId, xpSamples.bucket],
          set: { xp: sql`GREATEST(${xpSamples.xp}, excluded.xp)` },
        });
    await upsert(1000);
    await upsert(900);
    await upsert(1200);
    await t.db.insert(xpSamples).values({ accountId, skillId: 1, bucket: new Date('2026-09-28T10:45:00Z'), xp: 1500, level: 2 });
    const rows = await t.db.execute<{ bucket: Date; xp: number }>(
      sql`SELECT bucket, xp FROM xp_hourly WHERE account_id = ${accountId} AND skill_id = 1`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.xp).toBe(1500);
    const raw = await t.db.select().from(xpSamples).where(sql`${xpSamples.accountId} = ${accountId}`).orderBy(xpSamples.bucket);
    expect(raw.map((r) => r.xp)).toEqual([1200, 1500]);
  });

  it('enforces the enum CHECK constraints', async () => {
    await expect(
      t.db.execute(sql`INSERT INTO skills (name, kind) VALUES ('X', 'nope')`),
    ).rejects.toThrow();
    await expect(
      t.db.execute(
        sql`INSERT INTO osrs_accounts (public_id, account_hash, current_name, name_normalized, status) VALUES ('p2', 'x', 'a', 'a', 'bogus')`,
      ),
    ).rejects.toThrow();
  });
});
