/**
 * Offboarding and deletion (handoff §14, D-25, D-35): active → grace → hard delete; "Delete my data"
 * is the same pipeline started by the user, with a 7-day undo (D-78).
 */
export { offboardUser, restoreUser, type OffboardResult } from './offboard';
export { expireGracePeriods } from './expire';
export { purgeOrphanedAccounts } from './purge';
export { recordSignIn, type SignInSnapshot } from './sign-in';
export {
  SELF_DELETE_CONFIRMATION,
  SELF_DELETE_UNDO_DAYS,
  SelfDeleteError,
  deleteMyData,
  isSelfDeleteConfirmation,
  type SelfDeleteErrorCode,
  type SelfDeleteResult,
} from './self-delete';
