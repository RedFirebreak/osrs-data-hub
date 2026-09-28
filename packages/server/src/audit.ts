import { auditLog, type DbOrTx } from '@hub/db';

export interface AuditEntry {
  actorUserId?: string | null;
  /** 'system' | 'worker' | a display-name snapshot. */
  actorLabel?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  /** Never tokens or coordinates. */
  meta?: Record<string, unknown> | null;
}

export async function audit(db: DbOrTx, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actorUserId: entry.actorUserId ?? null,
    actorLabel: entry.actorLabel ?? null,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    meta: entry.meta ?? null,
  });
}
