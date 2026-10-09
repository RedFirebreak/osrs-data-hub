import { auditLog, type DbOrTx } from '@hub/db';

/**
 * Every action the hub writes to audit_log.action. These are stored strings: renaming one orphans the
 * rows already written, and a retired one stays in old rows. The admin audit page labels each of
 * them (apps/web admin-model.ts, a Record over AuditAction), so a new action doesn't compile until it
 * has a label.
 */
export const AUDIT_ACTIONS = [
  'user.offboarded',
  'user.restored',
  'user.deleted',
  'user.exported',
  'device.paired',
  'device.revoked',
  'account.ownership_transferred',
  'account.ownership_claimed',
  'account.contributor_blocked',
  'account.contributor_unblocked',
  'account.contributor_removed',
  'account.purged',
  'sharing.audience_changed',
  'sharing.grant_added',
  'sharing.grant_removed',
  'sharing.hidden_from_guild_changed',
  'api_key.created',
  'api_key.revoked',
  'service_key.created',
  'service_key.revoked',
  'raw_payload.viewed',
  'hub.decommissioned',
  'hub.guild_feed_changed',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * The actor of what the hub does by itself (grace expiry, the orphan purge, an ownership move made
 * by ingest or offboarding): no user, labelled 'system'.
 */
export const SYSTEM_ACTOR = { actorUserId: null, actorLabel: 'system' } as const;

export interface AuditEntry {
  actorUserId?: string | null;
  /** 'system' | 'worker' | a display-name snapshot. */
  actorLabel?: string | null;
  action: AuditAction;
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
