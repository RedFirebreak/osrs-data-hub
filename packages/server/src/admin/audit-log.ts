/**
 * Admin → Audit log (handoff §12). Entries are kept AUDIT_LOG_RETENTION_DAYS (pruneAuditLog).
 */
import { auditLog, users, type Db } from '@hub/db';
import { desc, eq, lt } from 'drizzle-orm';

export const AUDIT_LOG_PAGE_MAX = 500;

export interface AuditLogRow {
  id: number;
  at: Date;
  /** Null for the system/worker, and once the actor was deleted (anonymized). */
  actorUserId: string | null;
  /** The actor's current display name, when they still exist. */
  actorName: string | null;
  /** 'system', 'worker', 'login', or a label snapshot. */
  actorLabel: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  meta: unknown;
}

/**
 * Audit entries, newest first (by id, i.e. insertion order). `before` pages: pass the last row's id.
 * `limit` is clamped to 1…AUDIT_LOG_PAGE_MAX.
 */
export async function listAuditLog(
  db: Db,
  opts: { limit: number; before?: number },
): Promise<AuditLogRow[]> {
  const limit = Number.isFinite(opts.limit)
    ? Math.min(AUDIT_LOG_PAGE_MAX, Math.max(1, Math.floor(opts.limit)))
    : AUDIT_LOG_PAGE_MAX;
  const before =
    opts.before !== undefined && Number.isSafeInteger(opts.before) ? opts.before : undefined;
  return db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      actorUserId: auditLog.actorUserId,
      actorName: users.name,
      actorLabel: auditLog.actorLabel,
      action: auditLog.action,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      meta: auditLog.meta,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(before !== undefined ? lt(auditLog.id, before) : undefined)
    .orderBy(desc(auditLog.id))
    .limit(limit);
}
