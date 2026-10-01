/**
 * Rules the admin API's route handlers and the admin pages both apply, so each side imports one
 * definition instead of the route reaching into a UI model. No React and no server packages: the
 * admin client components import this module too.
 */

/** Entries per page of the audit log: the page's first render, each "load more", the route's default. */
export const AUDIT_PAGE_SIZE = 50;

/**
 * Whether the text typed into the decommission confirmation is the hub name. Both sides are
 * trimmed: HUB_NAME is cut to 64 characters after trimming, and that cut can end on a space nobody
 * types (the page shows the name without it).
 */
export function decommissionConfirmMatches(typed: string | undefined, hubName: string): boolean {
  const expected = hubName.trim();
  return typed !== undefined && expected !== '' && typed.trim() === expected;
}
