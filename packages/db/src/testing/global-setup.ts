/**
 * Vitest globalSetup: builds a migrated template database once per run and provides its name to the
 * test files, which clone it (CREATE DATABASE … TEMPLATE, ~30 ms) via createTestDatabase().
 *
 * Each run gets its OWN template (hub_tpl_<random>), so concurrent runs (several projects, several
 * developers or agents on one server) never drop each other's template mid-clone.
 *
 * TimescaleDB's background scheduler connects to every database that has the extension, which makes
 * template clones fail with 55006 "source database is being accessed by other users". The template is
 * therefore locked (ALLOW_CONNECTIONS false) and its sessions terminated after migrating (TSDB-4).
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../migrate';
import { TEMPLATE_PREFIX, TEST_ADMIN_URL, urlForDatabase } from './config';

export default async function setup(project: TestProject) {
  const template = `${TEMPLATE_PREFIX}${randomBytes(5).toString('hex')}`;
  const admin = new pg.Client({ connectionString: TEST_ADMIN_URL });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Cannot reach the test database at ${redact(TEST_ADMIN_URL)}. Start it with ` +
        '`docker compose -f compose.dev.yaml up -d` or set TEST_DATABASE_URL. ' +
        `(${(err as Error).message})`,
      { cause: err },
    );
  }
  try {
    await admin.query(`CREATE DATABASE ${template}`);
    await runMigrations(urlForDatabase(TEST_ADMIN_URL, template));
    await admin.query(`ALTER DATABASE ${template} WITH ALLOW_CONNECTIONS false`);
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [template],
    );
  } finally {
    await admin.end();
  }
  project.provide('hubTemplateDb', template);

  return async function teardown() {
    const a = new pg.Client({ connectionString: TEST_ADMIN_URL });
    await a.connect();
    try {
      await a.query(`DROP DATABASE IF EXISTS ${template} WITH (FORCE)`);
    } finally {
      await a.end();
    }
  };
}

function redact(url: string) {
  const u = new URL(url);
  if (u.password) u.password = '***';
  return u.toString();
}
