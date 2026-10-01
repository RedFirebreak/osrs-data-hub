/**
 * Labels of the audit log's actions (Admin → Audit log). In its own file so the label map can be typed
 * with the server's action list: a type-only import, since client components import this (NEXT-12).
 */
import type { AuditAction } from '@hub/server';

/** A label for every action the hub writes, so a new action doesn't compile until it has one. */
const AUDIT_ACTION_LABELS: Readonly<Record<AuditAction, string>> = {
  'user.offboarded': 'User offboarded',
  'user.restored': 'User restored',
  'user.deleted': 'User deleted',
  'user.exported': 'User data downloaded',
  'device.paired': 'Device paired',
  'device.revoked': 'Device revoked',
  'account.ownership_claimed': 'Ownership claimed',
  'account.ownership_transferred': 'Ownership transferred',
  'account.contributor_blocked': 'Contributor blocked',
  'account.contributor_unblocked': 'Contributor unblocked',
  'account.contributor_removed': 'Contributor removed',
  'account.purged': 'Account purged',
  'sharing.audience_changed': 'Sharing audience changed',
  'sharing.grant_added': 'Sharing grant added',
  'sharing.grant_removed': 'Sharing grant removed',
  'raw_payload.viewed': 'Raw payload viewed',
  'hub.decommissioned': 'Decommission switch',
  'hub.guild_feed_changed': 'Guild feed settings changed',
  'api_key.created': 'API key created',
  'api_key.revoked': 'API key revoked',
  'service_key.created': 'Service key created',
  'service_key.revoked': 'Service key revoked',
};

/** Actions no code writes any more; rows from before may still hold them. */
const RETIRED_AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  'sharing.changed': 'Sharing changed',
};

const AUDIT_LABEL_BY_ACTION: ReadonlyMap<string, string> = new Map(
  Object.entries({ ...RETIRED_AUDIT_ACTION_LABELS, ...AUDIT_ACTION_LABELS }),
);

/** A readable label for an audit action; the action itself when this version doesn't know it. */
export function auditActionLabel(action: string): string {
  return AUDIT_LABEL_BY_ACTION.get(action) ?? action;
}
