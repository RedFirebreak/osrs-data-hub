import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client';

/** Default location of the SQL migrations when running from source. */
export const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', 'drizzle');

/**
 * Applies all pending migrations. drizzle's migrator runs every pending migration inside ONE
 * transaction and decides what to run by timestamp, not hash (DB-7, DB-8).
 */
export async function runMigrations(connectionString: string, migrationsFolder = MIGRATIONS_DIR) {
  const { db, pool } = createDb(connectionString, { max: 1, applicationName: 'hub-migrate' });
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}
