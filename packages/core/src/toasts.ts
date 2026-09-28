import { notImplemented } from './todo';

export interface ToastFilter {
  enabled: boolean;
  /** null = all event types. */
  types: readonly string[] | null;
  /** Applies to loot and pk_loot only. */
  minLootValue: number;
  ownAccountsOnly: boolean;
}

export const DEFAULT_TOAST_FILTER: ToastFilter = {
  enabled: true,
  types: null,
  minLootValue: 0,
  ownAccountsOnly: false,
};

/**
 * Whether to show a toast for an event the viewer is already allowed to see (permission is checked
 * separately). False when: disabled; older than TOAST_MAX_AGE_MS (15 min) at `now`; type not in
 * types (when set); loot/pk_loot below minLootValue (null value counts as 0); ownAccountsOnly and
 * the account isn't the viewer's (owner or contributor).
 */
export function shouldToast(
  event: { type: string; valueGp: number | null; occurredAt: Date },
  filter: ToastFilter,
  ctx: { isOwnAccount: boolean; now: Date },
): boolean {
  return notImplemented('shouldToast');
}
