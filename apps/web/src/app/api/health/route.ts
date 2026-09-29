/**
 * GET /api/health — liveness plus database reachability for the container healthcheck and uptime
 * monitors (D-14). No auth, nothing about the deployment in the body: 200 `{"ok":true}` when
 * `SELECT 1` succeeds within 2 s, else 503 `{"ok":false}` (the reason is logged, never returned).
 */
import { getDb, isTransientDbError, pgErrorCode } from '@hub/db';
import { getLogger } from '@hub/server';
import { sql } from 'drizzle-orm';
import { connection } from 'next/server';
import { json } from '@/lib/http';

const DB_TIMEOUT_MS = 2_000;

export async function GET(): Promise<Response> {
  await connection();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('health check timed out')), DB_TIMEOUT_MS);
    });
    await Promise.race([getDb().db.execute(sql`SELECT 1`), timeout]);
    return json(200, { ok: true });
  } catch (err) {
    // DB-3: the SQLSTATE only.
    getLogger().warn(
      { pgCode: pgErrorCode(err), transient: isTransientDbError(err) },
      'health: database check failed',
    );
    return json(503, { ok: false });
  } finally {
    clearTimeout(timer);
  }
}
