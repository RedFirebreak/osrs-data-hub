/**
 * Vitest globalSetup: builds a migrated template database once per run. Each test file then clones it
 * (CREATE DATABASE … TEMPLATE, ~30 ms) via createTestDatabase().
 *
 * TimescaleDB's background scheduler connects to every database that has the extension, which makes
 * template clones fail with 55006 "source database is being accessed by other users". The template is
 * therefore locked (ALLOW_CONNECTIONS false) and its sessions terminated after migrating (TSDB-4).
 */
import pg from 'pg';
import { runMigrations } from '../migrate';
import { TEMPLATE_DB, TEST_ADMIN_URL, urlForDatabase } from './config';

export default async function setup() {
  const admin = new pg.Client({ connectionString: TEST_ADMIN_URL });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Cannot reach the test database at ${redact(TEST_ADMIN_URL)}. Start it with ` +
        '`docker compose -f compose.dev.yaml up -d` or set TEST_DATABASE_URL. ' +
        `(${(err as Error).message})`,
    );
  }
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
    await runMigrations(urlForDatabase(TEST_ADMIN_URL, TEMPLATE_DB));
    await admin.query(`ALTER DATABASE ${TEMPLATE_DB} WITH ALLOW_CONNECTIONS false`);
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [TEMPLATE_DB],
    );
  } finally {
    await admin.end();
  }
}

function redact(url: string) {
  const u = new URL(url);
  if (u.password) u.password = '***';
  return u.toString();
}
