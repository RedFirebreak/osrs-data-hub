import { isLootEvent } from './events/types';
import { TOAST_MAX_AGE_MS } from './time';

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
 * separately). False when: disabled; TOAST_MAX_AGE_MS (15 min) old or older at `now`; type not in
 * types (when set); loot/pk_loot below minLootValue (null value counts as 0); ownAccountsOnly and
 * the account isn't the viewer's (owner or contributor). An event exactly TOAST_MAX_AGE_MS old is
 * skipped: occurred_at is clamped to recv − 15 min (EVENT_CLAMP_MS, D-17), so that value means "at
 * least 15 min old, maybe hours", and it must not toast just because `now` equals recv. An invalid
 * occurredAt never toasts. An event dated after `now` is not old, so it toasts. An empty `types`
 * array allows nothing.
 */
export function shouldToast(
  event: { type: string; valueGp: number | null; occurredAt: Date },
  filter: ToastFilter,
  ctx: { isOwnAccount: boolean; now: Date },
): boolean {
  if (!filter.enabled) return false;
  // Written as !(age < max) so an invalid occurredAt (NaN) counts as too old.
  const ageMs = ctx.now.getTime() - event.occurredAt.getTime();
  if (!(ageMs < TOAST_MAX_AGE_MS)) return false;
  if (filter.types !== null && !filter.types.includes(event.type)) return false;
  if (isLootEvent(event.type) && (event.valueGp ?? 0) < filter.minLootValue) return false;
  if (filter.ownAccountsOnly && !ctx.isOwnAccount) return false;
  return true;
}
