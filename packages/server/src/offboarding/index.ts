/**
 * Offboarding and deletion (handoff §14, D-25, D-35): active → grace → hard delete.
 */
export { offboardUser, restoreUser, type OffboardResult } from './offboard';
export { expireGracePeriods } from './expire';
export { purgeOrphanedAccounts } from './purge';
