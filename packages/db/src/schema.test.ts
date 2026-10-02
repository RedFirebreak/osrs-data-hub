import { readFileSync } from 'node:fs';
import path from 'node:path';
import { asc, eq, is, sql, type SQL } from 'drizzle-orm';
import { PgDialect, PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from './migrate';
import { createTestDatabase, type TestDatabase } from './testing';
import * as schema from './schema';
import { accountSharing, locationSamples, osrsAccounts, skills, xpSamples } from './schema';

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
      .values({
        publicId: 'p1',
        accountHash: 'h'.repeat(56),
        currentName: 'Zezima',
        nameNormalized: 'zezima',
      })
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
    await t.db.insert(xpSamples).values({
      accountId,
      skillId: 1,
      bucket: new Date('2026-09-28T10:45:00Z'),
      xp: 1500,
      level: 2,
    });
    const rows = await t.db.execute<{ bucket: Date; xp: number }>(
      sql`SELECT bucket, xp FROM xp_hourly WHERE account_id = ${accountId} AND skill_id = 1`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.xp).toBe(1500);
    const raw = await t.db
      .select()
      .from(xpSamples)
      .where(sql`${xpSamples.accountId} = ${accountId}`)
      .orderBy(xpSamples.bucket);
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

  // The enum-like CHECKs are built from the shared value arrays (@hub/core CATEGORIES, AUDIENCES, …)
  // with check(), but 0001 created them as hand-written SQL and 0008 only recorded them in Drizzle's
  // snapshot. This holds the two together: every CHECK the schema declares, created on an empty copy
  // of its table, must come out as the definition the migrations left in the database, and the
  // database must have no CHECK the schema doesn't know. A failure after changing an array means its
  // migration is missing: run `pnpm db:generate`.
  it('has exactly the CHECK constraints the schema declares', async () => {
    const definitions = (namespace: SQL) => sql`
      SELECT c.conrelid::regclass::text AS "table", c.conname AS name, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      WHERE c.contype = 'c' AND c.connamespace = ${namespace}
      ORDER BY c.conname`;
    type Row = { table: string; name: string; def: string };
    const byName = (rows: Row[]) =>
      Object.fromEntries(
        rows.map((r) => [`${r.table.replace(/^pg_temp[^.]*\./, '')}.${r.name}`, r.def]),
      );

    const dialect = new PgDialect();
    const declared = await t.db.transaction(async (tx) => {
      for (const table of Object.values(schema)) {
        if (!is(table, PgTable)) continue;
        const { name, checks } = getTableConfig(table);
        if (checks.length === 0) continue;
        // The temp table shadows the real one, so the table-qualified columns in the SQL drizzle-kit
        // would generate (`"users"."status" IN (…)`) resolve to it.
        await tx.execute(
          sql.raw(`CREATE TEMP TABLE "${name}" (LIKE public."${name}") ON COMMIT DROP`),
        );
        for (const c of checks) {
          const expression = dialect.sqlToQuery(c.value).sql;
          await tx.execute(
            sql.raw(
              `ALTER TABLE pg_temp."${name}" ADD CONSTRAINT "${c.name}" CHECK (${expression})`,
            ),
          );
        }
      }
      return byName((await tx.execute<Row>(definitions(sql`pg_my_temp_schema()`))).rows);
    });
    const migrated = byName(
      (await t.db.execute<Row>(definitions(sql`'public'::regnamespace`))).rows,
    );

    expect(Object.keys(declared)).toContain('account_sharing.account_sharing_category_chk');
    expect(migrated).toEqual(declared);
  });
});

describe('0007_sharing_keep_private (D-96)', () => {
  // The template database ran the migration on empty tables; running its SQL again here is what a
  // deployment with accounts gets.
  const migration = readFileSync(
    path.join(MIGRATIONS_DIR, '0007_sharing_keep_private.sql'),
    'utf8',
  );

  async function addAccount(publicId: string): Promise<number> {
    const [acc] = await t.db
      .insert(osrsAccounts)
      .values({
        publicId,
        accountHash: publicId.padEnd(56, 'x'),
        currentName: publicId,
        nameNormalized: publicId,
      })
      .returning({ id: osrsAccounts.id });
    return acc!.id;
  }

  const sharingOf = async (accountId: number) =>
    Object.fromEntries(
      (
        await t.db
          .select({ category: accountSharing.category, audience: accountSharing.audience })
          .from(accountSharing)
          .where(eq(accountSharing.accountId, accountId))
          .orderBy(asc(accountSharing.category))
      ).map((r) => [r.category, r.audience]),
    );

  it('pins the formerly private categories of an existing account to private, and nothing else', async () => {
    const untouched = await addAccount('pin-untouched');
    await t.db.execute(sql.raw(migration));
    expect(await sharingOf(untouched)).toEqual({
      equipment: 'private',
      inventory: 'private',
      location_history: 'private',
    });
  });

  it("keeps an owner's explicit choices", async () => {
    const chosen = await addAccount('pin-chosen');
    await t.db.insert(accountSharing).values([
      { accountId: chosen, category: 'inventory', audience: 'guild' },
      { accountId: chosen, category: 'equipment', audience: 'selected' },
      { accountId: chosen, category: 'stats', audience: 'private' },
    ]);
    await t.db.execute(sql.raw(migration));
    expect(await sharingOf(chosen)).toEqual({
      equipment: 'selected',
      inventory: 'guild',
      location_history: 'private',
      stats: 'private',
    });
  });
});

describe('0009_location_samples_columnstore (D-102)', () => {
  it('segments location_samples by account and orders it by time, like the trail is read', async () => {
    const settings = await t.db.execute<{ segmentby: string; orderby: string }>(
      sql`SELECT segmentby, orderby FROM timescaledb_information.hypertable_columnstore_settings
          WHERE hypertable::text = 'location_samples'`,
    );
    expect(settings.rows).toEqual([{ segmentby: 'account_id', orderby: 'ts DESC' }]);
  });

  it('a compressed chunk still reads, dedupes a resent point and loses an account with its rows', async () => {
    const account = (n: number) => ({
      publicId: `trail${n}`,
      accountHash: String(n).repeat(56),
      currentName: `Trail ${n}`,
      nameNormalized: `trail ${n}`,
    });
    const [a, b] = await t.db
      .insert(osrsAccounts)
      .values([account(7), account(8)])
      .returning({ id: osrsAccounts.id });
    const at = (ms: number) => new Date(Date.UTC(2026, 8, 20, 12, 0, 0, ms));
    const point = (accountId: number, ms: number, x: number) => ({
      accountId,
      ts: at(ms),
      x,
      y: 3200,
      plane: 0,
      world: 302,
    });
    await t.db
      .insert(locationSamples)
      .values([
        point(a!.id, 0, 1),
        point(a!.id, 600, 2),
        point(a!.id, 1200, 3),
        point(b!.id, 0, 9),
        point(b!.id, 600, 10),
      ]);

    await t.db.execute(sql`SELECT compress_chunk(c) FROM show_chunks('location_samples') c`);
    const chunks = await t.db.execute<{ is_compressed: boolean }>(
      sql`SELECT is_compressed FROM timescaledb_information.chunks
          WHERE hypertable_name = 'location_samples'`,
    );
    expect(chunks.rows).toEqual([{ is_compressed: true }]);

    const trail = (accountId: number) =>
      t.db
        .select({ ts: locationSamples.ts, x: locationSamples.x })
        .from(locationSamples)
        .where(eq(locationSamples.accountId, accountId))
        .orderBy(asc(locationSamples.ts));
    expect((await trail(a!.id)).map((r) => r.x)).toEqual([1, 2, 3]);

    // The same point again (a resend) changes nothing; a new one is added.
    await t.db
      .insert(locationSamples)
      .values([point(a!.id, 600, 77), point(a!.id, 1800, 4)])
      .onConflictDoNothing();
    expect((await trail(a!.id)).map((r) => r.x)).toEqual([1, 2, 3, 4]);

    await t.db.delete(osrsAccounts).where(eq(osrsAccounts.id, a!.id));
    expect(await trail(a!.id)).toEqual([]);
    expect((await trail(b!.id)).map((r) => r.x)).toEqual([9, 10]);
  });
});
