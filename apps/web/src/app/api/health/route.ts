/**
 * GET /api/health — liveness plus database reachability for the container healthcheck and uptime
 * monitors (D-14). No auth, nothing about the deployment in the body: 200 `{"ok":true}` when
 * `SELECT 1` succeeds within 2 s (pingDatabase), else 503 `{"ok":false}` (the reason is logged,
 * never returned).
 */
import { getDb, isTransientDbError, pgErrorCode } from '@hub/db';
import { getLogger, pingDatabase } from '@hub/server';
import { connection } from 'next/server';
import { json } from '@/lib/http';

const DB_TIMEOUT_MS = 2_000;

export async function GET(): Promise<Response> {
  await connection();
  try {
    await pingDatabase(getDb().db, DB_TIMEOUT_MS);
    return json(200, { ok: true });
  } catch (err) {
    // DB-3: the SQLSTATE only.
    getLogger().warn(
      { pgCode: pgErrorCode(err), transient: isTransientDbError(err) },
      'health: database check failed',
    );
    return json(503, { ok: false });
  }
}
