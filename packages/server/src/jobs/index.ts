/**
 * Scheduled work the worker runs (handoff §11, D-43): stale sessions, Discord re-verification and
 * audit-log pruning. Grace expiry lives in ../offboarding.
 */
export { closeStaleSessions } from './sessions';
export { reverifyDueMembers, type ReverifyDeps, type ReverifyResult } from './reverify';
export { pruneAuditLog } from './audit-log';
