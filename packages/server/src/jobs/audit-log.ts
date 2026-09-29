import { auditLog, type Db } from '@hub/db';
import { lt } from 'drizzle-orm';

const DAY_MS = 86_400_000;

/** Deletes audit entries older than retentionDays. */
export async function pruneAuditLog(
  db: Db,
  opts: { retentionDays: number; now?: Date },
): Promise<{ deleted: number }> {
  // A zero, negative or NaN retention would empty the whole log: refuse it rather than guess.
  if (!Number.isFinite(opts.retentionDays) || opts.retentionDays <= 0) {
    throw new RangeError('pruneAuditLog: retentionDays must be a positive number');
  }
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - opts.retentionDays * DAY_MS);
  const res = await db.delete(auditLog).where(lt(auditLog.at, cutoff));
  return { deleted: res.rowCount ?? 0 };
}
