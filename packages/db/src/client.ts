import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
/** A transaction handle, as passed to `db.transaction(async (tx) => …)`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Either the database or a transaction: most query helpers accept both. */
export type DbOrTx = Db | Tx;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
}

export interface CreateDbOptions {
  /** Pool size. Keep the sum over all processes under Postgres max_connections (DB-5). */
  max?: number;
  applicationName?: string;
}

// timestamptz and bigint arrive as strings by default; drizzle maps columns itself, but raw
// `db.execute` results should parse int8 into numbers (all our int8 values are < 2^53).
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));

export function createDb(connectionString: string, opts: CreateDbOptions = {}): DbHandle {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? 'osrs-data-hub',
    // Fail fast instead of hanging a plugin request past its 10 s read timeout (PLUGIN-4).
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  // An idle client erroring (e.g. DB restart) must not crash the process.
  pool.on('error', () => {});
  const db = drizzle(pool, { schema });
  return { db, pool };
}

const g = globalThis as unknown as { __hubDb?: DbHandle };

/**
 * Process-wide pool on globalThis. Next.js runs route handlers and RSC/server code in separate module
 * instances, so a module-level singleton would create one pool per instance (NEXT-3).
 */
export function getDb(
  connectionString = process.env.DATABASE_URL,
  opts: CreateDbOptions = {},
): DbHandle {
  if (!g.__hubDb) {
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    g.__hubDb = createDb(connectionString, opts);
  }
  return g.__hubDb;
}

export { schema };
