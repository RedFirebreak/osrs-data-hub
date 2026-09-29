/** Database reachability for `GET /api/health` (D-14). */
import type { Db } from '@hub/db';
import { sql } from 'drizzle-orm';

/**
 * Resolves when the database answers `SELECT 1` within `timeoutMs`, else rejects (a timeout, or the
 * query's error: callers log its code only, DB-3).
 */
export async function pingDatabase(db: Db, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('database ping timed out')), timeoutMs);
  });
  try {
    await Promise.race([db.execute(sql`SELECT 1`), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
