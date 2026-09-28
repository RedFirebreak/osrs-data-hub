/**
 * Per-test-file database isolation. Usage:
 *
 *   const t = await createTestDatabase();   // in beforeAll
 *   t.db.insert(…)
 *   await t.drop();                         // in afterAll
 *
 * Requires the vitest globalSetup `src/testing/global-setup.ts` (builds the template).
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDb, type DbHandle } from './client';
import { TEMPLATE_DB, TEST_ADMIN_URL, urlForDatabase } from './testing/config';

export interface TestDatabase extends DbHandle {
  url: string;
  name: string;
  drop(): Promise<void>;
}

export async function createTestDatabase(label = 'test'): Promise<TestDatabase> {
  const name = `hub_t_${label
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .slice(0, 20)}_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: TEST_ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }
  const url = urlForDatabase(TEST_ADMIN_URL, name);
  const handle = createDb(url, { max: 5, applicationName: `test-${label}` });
  return {
    ...handle,
    url,
    name,
    async drop() {
      await handle.pool.end().catch(() => {});
      const a = new pg.Client({ connectionString: TEST_ADMIN_URL });
      await a.connect();
      try {
        await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await a.end();
      }
    },
  };
}

export { TEST_ADMIN_URL };
